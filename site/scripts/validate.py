#!/usr/bin/env python3
"""Validate the static greenroomai.net shell without third-party dependencies."""

from __future__ import annotations

import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

SITE = Path(__file__).resolve().parents[1]
PAGES = {
    "index.html": "Project",
    "docs/index.html": "Docs",
    "download/index.html": "Download",
    "contribute/index.html": "Contribute",
}
REQUIRED_LANGUAGE = {
    "index.html": (
        "standalone",
        "inspired by Block’s Buzz",
        "not endorsed",
        "local-first",
        "your own local or cloud LLM",
        "bounded context",
        "forthcoming",
    ),
    "docs/index.html": ("local runtime", "cloud provider", "bounded context"),
    "download/index.html": ("forthcoming", "no downloadable release"),
    "contribute/index.html": ("GitHub", "content and legal boundaries"),
}
FORBIDDEN_TEXT = (
    "download now",
    "available now",
    "sign up",
    "join waitlist",
    "enter your api key",
)
FORBIDDEN_ATTRS = ("action", "method", "onload", "onclick", "onerror")
REMOTE_SCHEMES = ("http://", "https://", "//")
ALLOWED_REMOTE_LINK_HOSTS = {"github.com", "github.com/block/buzz"}


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[tuple[str, dict[str, str]]] = []
        self.text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append((tag, {key: value or "" for key, value in attrs}))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_data(self, data: str) -> None:
        self.text.append(data)


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def local_target(page: Path, href: str) -> Path | None:
    if not href or href.startswith(("#", "mailto:")):
        return None
    parsed = urlparse(href)
    if parsed.scheme or parsed.netloc:
        return None
    clean = href.split("#", 1)[0].split("?", 1)[0]
    if not clean:
        return None
    if clean.startswith("/"):
        target = SITE / clean.lstrip("/")
    else:
        target = page.parent / clean
    if clean.endswith("/"):
        target /= "index.html"
    return target.resolve()


def validate_page(relative: str, errors: list[str]) -> None:
    page = SITE / relative
    if not page.is_file():
        fail(errors, f"missing required page: {relative}")
        return

    source = page.read_text(encoding="utf-8")
    parser = PageParser()
    parser.feed(source)
    text = " ".join(" ".join(parser.text).split())
    lower = text.lower()

    if not source.lstrip().lower().startswith("<!doctype html>"):
        fail(errors, f"{relative}: missing HTML5 doctype")
    if not re.search(r'<html\b[^>]*\blang="en"', source, re.I):
        fail(errors, f"{relative}: missing html lang=en")
    if "<main" not in source.lower() or "<h1" not in source.lower():
        fail(errors, f"{relative}: missing main landmark or h1")
    if 'class="skip-link"' not in source:
        fail(errors, f"{relative}: missing skip link")

    metas = [attrs for tag, attrs in parser.tags if tag == "meta"]
    links = [attrs for tag, attrs in parser.tags if tag == "link"]
    if not any(meta.get("name") == "description" and meta.get("content") for meta in metas):
        fail(errors, f"{relative}: missing description metadata")
    for prop in ("og:title", "og:description", "og:image", "og:type"):
        if not any(meta.get("property") == prop and meta.get("content") for meta in metas):
            fail(errors, f"{relative}: missing {prop} metadata")
    if not any(link.get("rel") == "canonical" and link.get("href") for link in links):
        fail(errors, f"{relative}: missing canonical link")

    for phrase in REQUIRED_LANGUAGE[relative]:
        if phrase.lower() not in lower:
            fail(errors, f"{relative}: missing required language: {phrase!r}")
    for phrase in FORBIDDEN_TEXT:
        if phrase in lower:
            fail(errors, f"{relative}: forbidden claim or collection language: {phrase!r}")

    for tag, attrs in parser.tags:
        if tag in {"form", "input", "textarea", "script", "iframe", "video", "audio"}:
            fail(errors, f"{relative}: forbidden active/collection element <{tag}>")
        for attr in FORBIDDEN_ATTRS:
            if attr in attrs:
                fail(errors, f"{relative}: forbidden attribute {attr} on <{tag}>")
        for attr in ("src", "href", "srcset"):
            value = attrs.get(attr, "").strip()
            if not value:
                continue
            if value.startswith(REMOTE_SCHEMES):
                is_canonical = tag == "link" and attrs.get("rel") == "canonical"
                if tag != "a" and not is_canonical:
                    fail(errors, f"{relative}: remote asset or embed: {value}")
                elif tag == "a":
                    host = urlparse(value).netloc.lower()
                    path_host = f"{host}{urlparse(value).path}".rstrip("/")
                    if host not in ALLOWED_REMOTE_LINK_HOSTS and path_host not in ALLOWED_REMOTE_LINK_HOSTS:
                        fail(errors, f"{relative}: unapproved remote link: {value}")
            target = local_target(page, value)
            if target is not None and not target.exists():
                fail(errors, f"{relative}: broken local reference: {value}")


def main() -> int:
    errors: list[str] = []
    for page in PAGES:
        validate_page(page, errors)

    css = SITE / "assets/site.css"
    if not css.is_file():
        fail(errors, "missing local stylesheet: assets/site.css")
    else:
        content = css.read_text(encoding="utf-8")
        for requirement in ("@media (max-width:", "prefers-reduced-motion", ":focus-visible"):
            if requirement not in content:
                fail(errors, f"assets/site.css: missing {requirement}")
        if re.search(r"url\(\s*['\"]?(?:https?:)?//", content, re.I):
            fail(errors, "assets/site.css: remote asset URL found")

    social = SITE / "assets/social-card-placeholder.svg"
    if not social.is_file():
        fail(errors, "missing text-only social metadata placeholder")

    readme = SITE / "README.md"
    if not readme.is_file():
        fail(errors, "missing site README")
    elif "future deployment contract" not in readme.read_text(encoding="utf-8").lower():
        fail(errors, "README: missing future deployment contract")

    if errors:
        print("Static site validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"Static site validation passed: {len(PAGES)} pages, local assets, policy language, and links checked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
