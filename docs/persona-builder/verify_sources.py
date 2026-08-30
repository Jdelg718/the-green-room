#!/usr/bin/env python3
"""Verify the authoritative research citations used by the template docs."""

from __future__ import annotations

import urllib.request

SOURCES = {
    "https://www.pon.harvard.edu/daily/batna/translate-your-batna-to-the-current-deal/": (
        "What is BATNA?",
        "Program on Negotiation",
    ),
    "https://www.pon.harvard.edu/tag/reservation-point/": (
        "Reservation Point",
        "Harvard Law School",
    ),
    "https://www.pon.harvard.edu/daily/negotiation-skills-daily/principled-negotiation-focus-interests-create-value/": (
        "Principled Negotiation",
        "Program on Negotiation",
    ),
    "https://www.pon.harvard.edu/daily/negotiation-skills-daily/four-strategies-for-making-concessions/": (
        "Making Concessions",
        "Program on Negotiation",
    ),
}


def main() -> None:
    for url, markers in SOURCES.items():
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "GreenRoom-doc-source-verifier/0.1 (+https://github.com/Jdelg718/the-green-room)"
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read(2_000_000).decode("utf-8", "replace")
            if response.status != 200:
                raise SystemExit(f"FAIL {response.status} {url}")
        missing = [
            marker for marker in markers if marker.casefold() not in body.casefold()
        ]
        if missing:
            raise SystemExit(f"FAIL missing {missing!r} in {url}")
        print(f"PASS {url}")


if __name__ == "__main__":
    main()
