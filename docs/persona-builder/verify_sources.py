#!/usr/bin/env python3
"""Verify the authoritative HTTPS research citations used by the template docs."""

from __future__ import annotations

import http.client
import time
from html.parser import HTMLParser
from urllib.parse import urlsplit

MAX_RESPONSE_BYTES = 2_000_000
TOTAL_DEADLINE_SECONDS = 60.0
ALLOWED_HOST = "www.pon.harvard.edu"
USER_AGENT = (
    "GreenRoom-doc-source-verifier/0.2 (+https://github.com/Jdelg718/the-green-room)"
)

SOURCES = {
    "https://www.pon.harvard.edu/daily/batna/translate-your-batna-to-the-current-deal/": (
        "What is BATNA? How to Find Your Best Alternative to a Negotiated Agreement",
        "Program on Negotiation",
    ),
    "https://www.pon.harvard.edu/tag/reservation-point/": (
        "Reservation Point",
        "Harvard Law School",
    ),
    "https://www.pon.harvard.edu/daily/negotiation-skills-daily/principled-negotiation-focus-interests-create-value/": (
        "Principled Negotiation: Focus on Interests to Create Value",
        "Program on Negotiation",
    ),
    "https://www.pon.harvard.edu/daily/negotiation-skills-daily/four-strategies-for-making-concessions/": (
        "Four Strategies for Making Concessions",
        "Program on Negotiation",
    ),
}


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
        if (
            tag.casefold() == "link"
            and (attributes.get("rel") or "").casefold() == "canonical"
        ):
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


def fetch(url: str, deadline: float) -> bytes:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != ALLOWED_HOST
        or parsed.port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise SystemExit(f"FAIL noncanonical HTTPS URL {url}")
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SystemExit("FAIL total source-verification deadline exceeded")
    connection = http.client.HTTPSConnection(ALLOWED_HOST, timeout=remaining)
    target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    try:
        connection.request(
            "GET",
            target,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html"},
        )
        response = connection.getresponse()
        if response.status != 200:
            location = response.getheader("Location")
            suffix = f" redirect={location!r}" if 300 <= response.status < 400 else ""
            raise SystemExit(f"FAIL HTTP {response.status} {url}{suffix}")
        body = bytearray()
        while True:
            if time.monotonic() >= deadline:
                raise SystemExit("FAIL total source-verification deadline exceeded")
            chunk = response.read(min(65_536, MAX_RESPONSE_BYTES + 1 - len(body)))
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


def main() -> None:
    deadline = time.monotonic() + TOTAL_DEADLINE_SECONDS
    for url, (exact_title, marker) in SOURCES.items():
        body = fetch(url, deadline)
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
        if exact_title not in parser.title:
            raise SystemExit(
                f"FAIL exact title mismatch expected substring={exact_title!r} got={parser.title!r}"
            )
        if marker.casefold() not in text.casefold():
            raise SystemExit(f"FAIL missing exact authority marker {marker!r} in {url}")
        print(f"PASS {url}")


if __name__ == "__main__":
    main()
