#!/usr/bin/env python3
"""Conservative, dependency-free release gate for the static greenroomai.net site."""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse

SITE = Path(__file__).resolve().parents[1]
SITE_ORIGIN = "https://greenroomai.net"
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

HTML_ATTRS: dict[str, frozenset[str]] = {
    "html": frozenset({"lang"}),
    "head": frozenset(),
    "meta": frozenset({"charset", "name", "content", "property", "http-equiv"}),
    "link": frozenset({"rel", "href", "type"}),
    "title": frozenset(),
    "body": frozenset(),
    "a": frozenset({"class", "href", "aria-label", "aria-current"}),
    "div": frozenset({"class", "aria-hidden"}),
    "header": frozenset({"class"}),
    "nav": frozenset({"class", "aria-label"}),
    "main": frozenset({"id"}),
    "section": frozenset({"class", "aria-labelledby"}),
    "span": frozenset({"class"}),
    "h1": frozenset({"class", "id"}),
    "h2": frozenset({"class", "id"}),
    "h3": frozenset({"class", "id"}),
    "p": frozenset({"class"}),
    "aside": frozenset({"class", "aria-label"}),
    "dl": frozenset(),
    "dt": frozenset(),
    "dd": frozenset(),
    "strong": frozenset(),
    "article": frozenset({"class"}),
    "ul": frozenset({"class"}),
    "ol": frozenset({"class"}),
    "li": frozenset(),
    "small": frozenset(),
    "footer": frozenset({"class"}),
    "code": frozenset(),
}
URL_BEARING_HTML_ATTRS = frozenset(
    {"href", "src", "srcset", "poster", "cite", "background", "action", "formaction", "data"}
)
ALLOWED_NAVIGATION_HOST = "github.com"

SVG_NAMESPACE = "http://www.w3.org/2000/svg"
SVG_ATTRS: dict[str, frozenset[str]] = {
    "svg": frozenset({"width", "height", "viewBox", "role", "aria-labelledby"}),
    "title": frozenset({"id"}),
    "desc": frozenset({"id"}),
    "rect": frozenset({"x", "y", "width", "height", "fill", "stroke", "stroke-width"}),
    "circle": frozenset({"cx", "cy", "r", "fill", "stroke", "stroke-width"}),
    "path": frozenset({"d", "fill", "stroke", "stroke-width"}),
    "text": frozenset({"x", "y", "fill", "font-family", "font-size", "font-weight"}),
}
SVG_URL_ATTRS = frozenset({"href", "src", "xlink:href"})
CSS_URL_RE = re.compile(r"url\s*\(([^)]*)\)", re.I)
CSS_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
CSS_ESCAPE_RE = re.compile(r"\\(?:([0-9a-fA-F]{1,6})\s?|(.))", re.S)


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[tuple[str, list[tuple[str, str]]]] = []
        self.text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append((tag.lower(), [(key.lower(), value or "") for key, value in attrs]))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_data(self, data: str) -> None:
        self.text.append(data)


class PolicyHTMLParser(PageParser):
    def __init__(self) -> None:
        super().__init__()
        self.parse_errors: list[str] = []

    def error(self, message: str) -> None:  # pragma: no cover - retained for old Python APIs
        self.parse_errors.append(message)



def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def display_path(path: Path, site: Path) -> str:
    try:
        return path.relative_to(site).as_posix()
    except ValueError:
        return str(path)


def compact_url(value: str) -> str:
    """Remove ASCII controls/whitespace so split-scheme tricks remain visible."""
    return re.sub(r"[\x00-\x20\x7f]+", "", value)


def decoded_path(value: str) -> str:
    previous = value
    for _ in range(3):
        decoded = unquote(previous)
        if decoded == previous:
            break
        previous = decoded
    return previous.replace("\\", "/")


def resolve_local_target(site: Path, page: Path, reference: str) -> tuple[Path | None, str | None]:
    """Resolve a local reference and reject lexical, encoded, or symlink escapes."""
    parsed = urlparse(compact_url(reference))
    clean = decoded_path(parsed.path)
    if not clean:
        return None, None
    target = site / clean.lstrip("/") if clean.startswith("/") else page.parent / clean
    if clean.endswith("/"):
        target /= "index.html"
    resolved_site = site.resolve()
    resolved_target = target.resolve()
    if not resolved_target.is_relative_to(resolved_site):
        return None, "escapes site root"
    return resolved_target, None


def validate_local_reference(
    label: str,
    value: str,
    errors: list[str],
    site: Path,
    page: Path,
) -> None:
    target, target_error = resolve_local_target(site, page, value)
    if target_error:
        fail(errors, f"{label}: local reference escapes site root: {value}")
    elif target is not None and not target.exists():
        fail(errors, f"{label}: broken local reference: {value}")


def validate_same_site_url(
    label: str,
    value: str,
    errors: list[str],
    site: Path,
    page: Path,
) -> None:
    parsed = urlparse(compact_url(value))
    if parsed.scheme != "https" or parsed.netloc.lower() != "greenroomai.net":
        fail(errors, f"{label}: metadata URL must use {SITE_ORIGIN}: {value}")
        return
    validate_local_reference(label, parsed.path or "/", errors, site, page)


def validate_html_url(
    label: str,
    tag: str,
    attrs: dict[str, str],
    attribute: str,
    value: str,
    errors: list[str],
    site: Path,
    page: Path,
) -> None:
    compact = compact_url(value)
    lower = compact.lower()
    if not compact:
        return
    if lower.startswith(("data:", "javascript:", "vbscript:", "file:", "//")):
        fail(errors, f"{label}: unsafe URL in {attribute} on <{tag}>: {value}")
        return

    parsed = urlparse(compact)
    if tag == "a" and attribute == "href" and parsed.scheme:
        if parsed.scheme != "https" or parsed.netloc.lower() != ALLOWED_NAVIGATION_HOST:
            fail(errors, f"{label}: unapproved navigation URL: {value}")
        return

    if tag == "link" and attrs.get("rel", "").lower() == "canonical":
        validate_same_site_url(label, value, errors, site, page)
        return

    if parsed.scheme or parsed.netloc:
        fail(errors, f"{label}: remote reference in {attribute} on <{tag}>: {value}")
        return
    if compact.startswith("#"):
        return
    validate_local_reference(label, value, errors, site, page)


def validate_html_policy(
    label: str,
    source: str,
    errors: list[str],
    site: Path,
    page: Path,
) -> PageParser:
    parser = PolicyHTMLParser()
    try:
        parser.feed(source)
        parser.close()
    except Exception as exc:
        fail(errors, f"{label}: malformed HTML: {exc}")
        return parser
    for parse_error in parser.parse_errors:
        fail(errors, f"{label}: malformed HTML: {parse_error}")

    for tag, attribute_pairs in parser.tags:
        allowed = HTML_ATTRS.get(tag)
        if allowed is None:
            fail(errors, f"{label}: forbidden or unsupported HTML element <{tag}>")
            allowed = frozenset()

        seen: set[str] = set()
        attrs: dict[str, str] = {}
        for attribute, value in attribute_pairs:
            if attribute in seen:
                fail(errors, f"{label}: duplicate attribute {attribute} on <{tag}>")
            seen.add(attribute)
            attrs[attribute] = value
            if attribute.startswith("on"):
                fail(errors, f"{label}: event handler attribute {attribute} on <{tag}>")
            if attribute not in allowed:
                fail(errors, f"{label}: forbidden or unsupported attribute {attribute} on <{tag}>")

        for attribute, value in attribute_pairs:
            if attribute in URL_BEARING_HTML_ATTRS:
                validate_html_url(label, tag, attrs, attribute, value.strip(), errors, site, page)

        if tag == "meta" and attrs.get("property", "").lower() in {"og:url", "og:image"}:
            validate_same_site_url(label, attrs.get("content", ""), errors, site, page)
        if tag == "meta" and "http-equiv" in attrs:
            if attrs["http-equiv"].strip().lower() != "content-security-policy":
                fail(errors, f"{label}: unsupported meta http-equiv policy")

    return parser


def validate_page(relative: str, errors: list[str], site: Path = SITE) -> None:
    page = site / relative
    if not page.is_file():
        fail(errors, f"missing required page: {relative}")
        return

    source = page.read_text(encoding="utf-8")
    parser = validate_html_policy(relative, source, errors, site, page)
    text = " ".join(" ".join(parser.text).split())
    lower = text.lower()

    if not source.lstrip().lower().startswith("<!doctype html>"):
        fail(errors, f"{relative}: missing HTML5 doctype")
    html_nodes = [dict(attrs) for tag, attrs in parser.tags if tag == "html"]
    if not any(attrs.get("lang", "").lower() == "en" for attrs in html_nodes):
        fail(errors, f"{relative}: missing html lang=en")
    if not any(tag == "main" for tag, _ in parser.tags) or not any(tag == "h1" for tag, _ in parser.tags):
        fail(errors, f"{relative}: missing main landmark or h1")
    if not any(tag == "a" and dict(attrs).get("class") == "skip-link" for tag, attrs in parser.tags):
        fail(errors, f"{relative}: missing skip link")

    metas = [dict(attrs) for tag, attrs in parser.tags if tag == "meta"]
    links = [dict(attrs) for tag, attrs in parser.tags if tag == "link"]
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


def css_unescape(source: str) -> str:
    def replace(match: re.Match[str]) -> str:
        if match.group(1):
            try:
                return chr(int(match.group(1), 16))
            except (ValueError, OverflowError):
                return ""
        return match.group(2) or ""

    return CSS_ESCAPE_RE.sub(replace, source)


def validate_css_source(
    label: str,
    source: str,
    errors: list[str],
    site: Path,
    css_path: Path,
) -> None:
    inspected = css_unescape(CSS_COMMENT_RE.sub("", source))
    if re.search(r"@import\b", inspected, re.I):
        fail(errors, f"{label}: @import is forbidden")
    for pattern, description in (
        (r"expression\s*\(", "CSS expression"),
        (r"(?:^|[;{])\s*behavior\s*:", "CSS behavior"),
        (r"-moz-binding\s*:", "CSS binding"),
    ):
        if re.search(pattern, inspected, re.I):
            fail(errors, f"{label}: {description} is forbidden")

    matches = list(CSS_URL_RE.finditer(inspected))
    if len(matches) != len(re.findall(r"url\s*\(", inspected, re.I)):
        fail(errors, f"{label}: malformed URL function")
    for match in matches:
        value = match.group(1).strip().strip("'\"").strip()
        compact = compact_url(value)
        if compact.startswith("#"):
            continue
        parsed = urlparse(compact)
        if (
            not compact
            or compact.lower().startswith(("data:", "javascript:", "vbscript:", "file:", "//"))
            or parsed.scheme
            or parsed.netloc
        ):
            fail(errors, f"{label}: remote URL found: {value}")
            continue
        target, target_error = resolve_local_target(site, css_path, value)
        if target_error:
            fail(errors, f"{label}: CSS URL escapes site root: {value}")
        elif target is not None and not target.exists():
            fail(errors, f"{label}: broken local CSS URL: {value}")


def split_xml_name(name: str) -> tuple[str | None, str]:
    if name.startswith("{") and "}" in name:
        namespace, local = name[1:].split("}", 1)
        return namespace, local
    return None, name


def validate_svg_reference(label: str, value: str, ids: set[str], errors: list[str]) -> None:
    compact = compact_url(value)
    if compact.startswith("#") and len(compact) > 1:
        if compact[1:] not in ids:
            fail(errors, f"{label}: broken local SVG fragment: {value}")
        return
    fail(errors, f"{label}: unsafe SVG URL reference: {value}")


def validate_svg_source(
    label: str,
    source: str,
    errors: list[str],
    site: Path,
    svg_path: Path,
) -> None:
    del site, svg_path  # SVG may reference only IDs in the same document.
    if re.search(r"<!\s*(?:doctype|entity)\b", source, re.I):
        fail(errors, f"{label}: SVG declarations/entities are forbidden")
        return
    try:
        root = ET.fromstring(source)
    except ET.ParseError as exc:
        fail(errors, f"{label}: malformed SVG: {exc}")
        return

    ids: set[str] = set()
    for element in root.iter():
        for raw_attribute, value in element.attrib.items():
            _, attribute = split_xml_name(raw_attribute)
            if attribute == "id":
                if not value or value in ids:
                    fail(errors, f"{label}: empty or duplicate SVG id: {value}")
                ids.add(value)

    for element in root.iter():
        namespace, tag = split_xml_name(element.tag)
        if namespace != SVG_NAMESPACE:
            fail(errors, f"{label}: non-SVG namespace on <{tag}>")
        allowed = SVG_ATTRS.get(tag)
        if allowed is None:
            fail(errors, f"{label}: forbidden or unsupported SVG element <{tag}>")
            allowed = frozenset()

        for raw_attribute, value in element.attrib.items():
            attribute_namespace, attribute = split_xml_name(raw_attribute)
            display_attribute = "xlink:href" if attribute_namespace else attribute
            if attribute.lower().startswith("on"):
                fail(errors, f"{label}: event handler attribute {attribute} on SVG <{tag}>")
            if attribute_namespace is not None or attribute not in allowed:
                fail(errors, f"{label}: forbidden or unsupported SVG attribute {display_attribute} on <{tag}>")
            if attribute in SVG_URL_ATTRS or display_attribute in SVG_URL_ATTRS:
                validate_svg_reference(label, value, ids, errors)
            url_matches = list(CSS_URL_RE.finditer(css_unescape(value)))
            if len(url_matches) != len(re.findall(r"url\s*\(", css_unescape(value), re.I)):
                fail(errors, f"{label}: malformed SVG URL function")
            for match in url_matches:
                reference = match.group(1).strip().strip("'\"").strip()
                validate_svg_reference(label, reference, ids, errors)


def collect_errors(site: Path = SITE) -> list[str]:
    errors: list[str] = []
    for page in PAGES:
        validate_page(page, errors, site)

    primary_css = site / "assets/site.css"
    if not primary_css.is_file():
        fail(errors, "missing local stylesheet: assets/site.css")
    else:
        content = primary_css.read_text(encoding="utf-8")
        for requirement in ("@media (max-width:", "prefers-reduced-motion", ":focus-visible"):
            if requirement not in content:
                fail(errors, f"assets/site.css: missing {requirement}")

    for css in sorted(site.rglob("*.css")):
        validate_css_source(
            display_path(css, site),
            css.read_text(encoding="utf-8"),
            errors,
            site,
            css,
        )

    for required_svg, message in (
        ("assets/favicon.svg", "missing local favicon"),
        ("assets/social-card-placeholder.svg", "missing text-only social metadata placeholder"),
    ):
        if not (site / required_svg).is_file():
            fail(errors, message)

    for svg in sorted(site.rglob("*.svg")):
        validate_svg_source(
            display_path(svg, site),
            svg.read_text(encoding="utf-8"),
            errors,
            site,
            svg,
        )

    readme = site / "README.md"
    if not readme.is_file():
        fail(errors, "missing site README")
    elif "future deployment contract" not in readme.read_text(encoding="utf-8").lower():
        fail(errors, "README: missing future deployment contract")
    return errors


def main() -> int:
    errors = collect_errors()
    if errors:
        print("Static site validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    svg_count = sum(1 for _ in SITE.rglob("*.svg"))
    print(
        f"Static site validation passed: {len(PAGES)} pages and {svg_count} SVGs; "
        "HTML/SVG allowlists, CSS, local targets, policy language, and links checked."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
