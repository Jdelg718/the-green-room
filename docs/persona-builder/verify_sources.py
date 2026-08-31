#!/usr/bin/env python3
"""Verify the authoritative HTTPS research citations used by the template docs."""

from __future__ import annotations

import argparse
import http.client
import time
from collections.abc import Callable
from html.parser import HTMLParser
from typing import Protocol, cast
from urllib.parse import urlsplit

MAX_RESPONSE_BYTES = 2_000_000
READ_CHUNK_BYTES = 65_536
TOTAL_DEADLINE_SECONDS = 60.0
ALLOWED_HOST = "www.pon.harvard.edu"
USER_AGENT = (
    "GreenRoom-doc-source-verifier/0.3 (+https://github.com/Jdelg718/the-green-room)"
)

SOURCES = {
    "https://www.pon.harvard.edu/daily/batna/translate-your-batna-to-the-current-deal/": (
        "What is BATNA? How to Find Your Best Alternative to a Negotiated Agreement - PON - Program on Negotiation at Harvard Law School",
        "Program on Negotiation",
    ),
    "https://www.pon.harvard.edu/tag/reservation-point/": (
        "What is the Reservation Point in Negotiation? - PON - Program on Negotiation at Harvard Law School",
        "Harvard Law School",
    ),
    "https://www.pon.harvard.edu/daily/negotiation-skills-daily/principled-negotiation-focus-interests-create-value/": (
        "Principled Negotiation: Focus on Interests to Create Value - PON - Program on Negotiation at Harvard Law School",
        "Program on Negotiation",
    ),
    "https://www.pon.harvard.edu/daily/negotiation-skills-daily/four-strategies-for-making-concessions/": (
        "Four Strategies for Making Concessions in Negotiation - PON - Program on Negotiation at Harvard Law School",
        "Program on Negotiation",
    ),
}


class SocketWithTimeout(Protocol):
    def settimeout(self, value: float | None) -> None: ...


class Response(Protocol):
    status: int

    def getheader(self, name: str, default: str | None = None) -> str | None: ...

    def read(self, amt: int | None = None) -> bytes: ...


class Connection(Protocol):
    timeout: float | None
    sock: SocketWithTimeout | None

    def request(
        self,
        method: str,
        url: str,
        body: object | None = None,
        headers: dict[str, str] | None = None,
        *,
        encode_chunked: bool = False,
    ) -> None: ...

    def getresponse(self) -> Response: ...

    def close(self) -> None: ...


CONNECTION_FACTORY = cast(Callable[..., Connection], http.client.HTTPSConnection)


class MetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.in_title = False
        self.title_parts: list[str] = []
        self.canonical_urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag.casefold() == "title":
            self.in_title = True
        rel = (attributes.get("rel") or "").casefold().split()
        if tag.casefold() == "link" and "canonical" in rel:
            href = attributes.get("href")
            if href is not None:
                self.canonical_urls.append(href)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)

    @property
    def title(self) -> str:
        return " ".join("".join(self.title_parts).split())


def validate_canonical_url(url: str) -> str:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.netloc != ALLOWED_HOST
        or parsed.hostname != ALLOWED_HOST
        or parsed.port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/")
        or not parsed.path.endswith("/")
        or parsed.geturl() != url
    ):
        raise SystemExit(f"FAIL noncanonical HTTPS URL {url}")
    return parsed.path


def remaining(deadline: float, clock: Callable[[], float]) -> float:
    value = deadline - clock()
    if value <= 0:
        raise SystemExit("FAIL total source-verification deadline exceeded")
    return value


def set_operation_timeout(connection: Connection, timeout: float) -> None:
    connection.timeout = timeout
    sock = connection.sock
    if sock is not None:
        sock.settimeout(timeout)


def fetch(
    url: str,
    deadline: float,
    *,
    clock: Callable[[], float] = time.monotonic,
    connection_factory: Callable[..., Connection] = CONNECTION_FACTORY,
) -> bytes:
    target = validate_canonical_url(url)
    connection = connection_factory(ALLOWED_HOST, timeout=remaining(deadline, clock))
    try:
        set_operation_timeout(connection, remaining(deadline, clock))
        connection.request(
            "GET",
            target,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html"},
        )
        remaining(deadline, clock)
        set_operation_timeout(connection, remaining(deadline, clock))
        response = connection.getresponse()
        remaining(deadline, clock)
        if response.status != 200:
            location = response.getheader("Location")
            suffix = f" redirect={location!r}" if 300 <= response.status < 400 else ""
            raise SystemExit(f"FAIL HTTP {response.status} {url}{suffix}")
        body = bytearray()
        while True:
            set_operation_timeout(connection, remaining(deadline, clock))
            allowance = MAX_RESPONSE_BYTES + 1 - len(body)
            chunk = response.read(min(READ_CHUNK_BYTES, allowance))
            remaining(deadline, clock)
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > MAX_RESPONSE_BYTES:
                raise SystemExit(
                    f"FAIL response exceeds {MAX_RESPONSE_BYTES} bytes {url}"
                )
        return bytes(body)
    finally:
        connection.close()


def verify_document(url: str, exact_title: str, marker: str, body: bytes) -> None:
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SystemExit(f"FAIL invalid UTF-8 {url}") from error
    parser = MetadataParser()
    parser.feed(text)
    if parser.canonical_urls != [url]:
        raise SystemExit(
            f"FAIL canonical URL mismatch expected={url!r} got={parser.canonical_urls!r}"
        )
    if parser.title != exact_title:
        raise SystemExit(
            f"FAIL exact title mismatch expected={exact_title!r} got={parser.title!r}"
        )
    if marker.casefold() not in text.casefold():
        raise SystemExit(f"FAIL missing exact authority marker {marker!r} in {url}")


def self_test() -> None:
    url, (title, marker) = next(iter(SOURCES.items()))
    valid = (
        f"<html><head><title>{title}</title>"
        f'<link rel="canonical" href="{url}"></head><body>{marker}</body></html>'
    ).encode()
    verify_document(url, title, marker, valid)

    forged = valid.replace(
        f"<title>{title}</title>".encode(),
        f"<title>{title} forged suffix</title>".encode(),
    )
    try:
        verify_document(url, title, marker, forged)
    except SystemExit as error:
        if "exact title mismatch" not in str(error):
            raise AssertionError(
                f"unstable forged-title diagnostic: {error}"
            ) from error
    else:
        raise AssertionError("forged title substring was accepted")

    wrong_canonical = valid.replace(url.encode(), (url + "forged/").encode())
    try:
        verify_document(url, title, marker, wrong_canonical)
    except SystemExit as error:
        if "canonical URL mismatch" not in str(error):
            raise AssertionError(f"unstable canonical diagnostic: {error}") from error
    else:
        raise AssertionError("forged canonical URL was accepted")

    now = [0.0]

    class DelayedResponse:
        status = 200

        @staticmethod
        def getheader(name: str, default: str | None = None) -> str | None:
            del name
            return default

        @staticmethod
        def read(amt: int | None = None) -> bytes:
            del amt
            now[0] = 1.01
            return b"delayed"

    class FakeSocket:
        def __init__(self) -> None:
            self.timeouts: list[float] = []

        def settimeout(self, value: float | None) -> None:
            if value is not None:
                self.timeouts.append(value)

    class DelayedConnection:
        def __init__(self, _host: str, timeout: float) -> None:
            self.timeout: float | None = timeout
            self.sock: SocketWithTimeout | None = FakeSocket()

        def request(self, *_args: object, **_kwargs: object) -> None:
            return None

        def getresponse(self) -> DelayedResponse:
            return DelayedResponse()

        def close(self) -> None:
            return None

    try:
        fetch(
            url,
            1.0,
            clock=lambda: now[0],
            connection_factory=DelayedConnection,
        )
    except SystemExit as error:
        if "deadline exceeded" not in str(error):
            raise AssertionError(
                f"unstable delayed-read diagnostic: {error}"
            ) from error
    else:
        raise AssertionError("read completing after total deadline was accepted")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("PASS source verifier self-tests")
        return
    deadline = time.monotonic() + TOTAL_DEADLINE_SECONDS
    for url, (exact_title, marker) in SOURCES.items():
        verify_document(url, exact_title, marker, fetch(url, deadline))
        print(f"PASS {url}")


if __name__ == "__main__":
    main()
