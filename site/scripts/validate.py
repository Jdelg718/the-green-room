#!/usr/bin/env python3
"""Conservative, dependency-free release gate for the static greenroomai.net site."""

from __future__ import annotations

import hashlib
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse

SITE = Path(__file__).resolve().parents[1]
SITE_ORIGIN = "https://greenroomai.net"
CHARACTER_PROFILES = {
    "ada-lovelace": "Ada Lovelace",
    "benjamin-franklin": "Benjamin Franklin",
    "elizabeth-i": "Elizabeth I",
    "frederick-douglass": "Frederick Douglass",
    "galileo-galilei": "Galileo Galilei",
    "george-washington": "George Washington",
    "isaac-newton": "Isaac Newton",
    "jane-austen": "Jane Austen",
    "leonardo-da-vinci": "Leonardo da Vinci",
    "mary-shelley": "Mary Shelley",
    "nicolaus-copernicus": "Nicolaus Copernicus",
    "thomas-jefferson": "Thomas Jefferson",
}
PROFILE_HORIZONS = {
    "ada-lovelace": "Through 26 November 1852",
    "benjamin-franklin": "Through 16 April 1790",
    "elizabeth-i": "Through 24 March 1603",
    "frederick-douglass": "Through 20 February 1895",
    "galileo-galilei": "Through 8 January 1642",
    "george-washington": "Through 14 December 1799",
    "isaac-newton": "Through 20 March 1727 (Old Style)",
    "jane-austen": "Through 17 July 1817",
    "leonardo-da-vinci": "Through 1 May 1519",
    "mary-shelley": "Through 1 February 1851",
    "nicolaus-copernicus": "Through 24 May 1543",
    "thomas-jefferson": "Through 4 July 1826",
}
PROFILE_BEHAVIOR = {
    "ada-lovelace": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "benjamin-franklin": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "elizabeth-i": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "frederick-douglass": ("Proactive initiative", "Rarely interrupts", "Expansive", "Independent", "Expressive range"),
    "galileo-galilei": ("Proactive initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "george-washington": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Restrained affect"),
    "isaac-newton": ("Measured initiative", "Rarely interrupts", "Measured detail", "Challenging", "Controlled range"),
    "jane-austen": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "leonardo-da-vinci": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "mary-shelley": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "nicolaus-copernicus": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Restrained affect"),
    "thomas-jefferson": ("Measured initiative", "Rarely interrupts", "Expansive", "Independent", "Controlled range"),
}
PORTRAIT_ASSETS = {
    "ada-lovelace": ("daa916a330fde6c45e6998e7cd447c205b71a89e28ef2e0ff890679f3566a5e2", 840, 1200, "AI-generated creative historical interpretation of Ada Lovelace in a dark study, wearing a high-collared black dress."),
    "benjamin-franklin": ("16951ccd809df29121a3417f344d4656320aef071a6cdf69138c89c9ca49e7c0", 768, 1024, "AI-generated creative historical interpretation of Benjamin Franklin in a brown coat, holding spectacles in a dim workshop."),
    "elizabeth-i": ("4436884480fe701940d8c9bd695940bc238e99ab71c65eacd9ba55fc4c77220c", 840, 1200, "AI-generated creative historical interpretation of Elizabeth I in a red embroidered gown and white ruff."),
    "frederick-douglass": ("e445dd92b3c36e4dff5bc920b408bfc239fabfe6f6ad60d0e22e4a4b93892b2b", 768, 1024, "AI-generated creative historical interpretation of Frederick Douglass with swept gray hair and a dark formal suit."),
    "galileo-galilei": ("81c1826e479b4b8b6357e69da3bd9142c34f7f47a8742b8386ce4b78b3603605", 840, 1200, "AI-generated creative historical interpretation of Galileo Galilei, white-bearded and seated beside books and a candle."),
    "george-washington": ("3883588e3ac035deed560893b1ddc1bca34c356c197c0094f179365d4b7a3a03", 768, 1024, "AI-generated creative historical interpretation of George Washington in a dark blue Continental-era coat beside surveying instruments."),
    "isaac-newton": ("b666032239adf370bfb187b612506466fabfa6d6d3272179d3055ef236c57466", 840, 1200, "AI-generated creative historical interpretation of Isaac Newton in a dark coat, seated at a candlelit desk."),
    "jane-austen": ("abf73e727337eb88b99dfbe2f318bced75e2ce9ef34689e96dd26758879345ea", 768, 1024, "AI-generated creative historical interpretation of Jane Austen in a modest cap and dark shawl beside a writing desk."),
    "leonardo-da-vinci": ("6340c0f43e05e46175bfaad85f200d4e8cd1be2754cac3f2a3843df294842acd", 840, 1200, "AI-generated creative historical interpretation of Leonardo da Vinci, white-bearded with one hand raised in thought."),
    "mary-shelley": ("6030a58352b00b3fea02b7e950d2a58fa464c51efbdd453933e68312486a633f", 768, 1024, "AI-generated creative historical interpretation of Mary Shelley in a black period dress at a storm-lit writing desk."),
    "nicolaus-copernicus": ("f7536c02c87c15fc238ca3b528bf4f17146cf814b3ffdbd486094948af1ebf6e", 768, 1024, "AI-generated creative historical interpretation of Nicolaus Copernicus in a red-and-black scholar’s robe beside astronomical notes."),
    "thomas-jefferson": ("1af3d4d7f72dc0f5d94f0f889bd14fca3a6c737c071c68e521580a4178b4fd06", 768, 1024, "AI-generated creative historical interpretation of Thomas Jefferson in a dark period coat in an architectural study."),
}
PROFILE_MAIN_TEXT_SHA256 = {
    "ada-lovelace": "e1adee83ce51b072c59b58082f0210a0d5e2867643f8f53f3eb6f2ed5df8905c",
    "benjamin-franklin": "c0bf900a588e842d967784528ac8e77cedd268e58c5795373ca83597f39b8b50",
    "elizabeth-i": "4e5e715b5727de184ec271f4a20cb1cee911ef2a703d01550b6858a6d6b881a7",
    "frederick-douglass": "c030c974ae769f3626f0c3a8d76e4a895b7a120df94f2fb3f04bae48882daff9",
    "galileo-galilei": "d6a3692553b0c11440533971052b6b708ce0f8017f9b6ee35fa3c6190f7e6370",
    "george-washington": "00888020e8928d25964fbbbb7ce97e16786d85b90cb605a8bd935559c6fb0276",
    "isaac-newton": "6047873db42dc17a58e025cdc58be655c7ecc30b642c183dad0c03cead9fbc94",
    "jane-austen": "e0343293df4988041a302a13004879ed2a11e640d1915f498df20c54ff02666f",
    "leonardo-da-vinci": "17b6c0b3caa8a6340ab7e095bee80092330f44fcda0ca54aaecfea8a460289fe",
    "mary-shelley": "4b2134e220046d98a0caa4c7b56f145bc0c6ee12d3fae025ff2417015840a2ea",
    "nicolaus-copernicus": "a7256c171f7106ca093c1a87e64723d3979b266e0db3f992c7086a1506da5022",
    "thomas-jefferson": "03616e60517c9796d748d41b93bf2b8b7f22f3e032b36bb401c702221f0d7d52",
}
PROFILE_SOURCE_SHA256 = {
    "ada-lovelace": "f53a16a183be7b9c35920a5ee72b0ef100b617ac516606526ba230ec717ecffc",
    "benjamin-franklin": "84a1d18d0a03f3675e458af1ba65cdaaba4820e35f90a5c7126b028c107adf29",
    "elizabeth-i": "16696c2114e0192fd6b324bc92833093f0d055c76d749da0afb144d3cbcf4596",
    "frederick-douglass": "45cefa7b2e8c3ca4ec1f90cedd643937d29aafaff2f8a9afbdde6ed1338ac053",
    "galileo-galilei": "6cddfb19ac73ed0cb060a49965f9bd37d6e3770cfae8db79f09db1c43d07de7f",
    "george-washington": "28733255b2a678e6d69995bcce174d06570fa63f922c26eef4f31fd72eab8e97",
    "isaac-newton": "2b0eee3b5734864ceed3c9af6f7f2f34d1b312319998761cf2049607d7c3da30",
    "jane-austen": "07f6773ffbe5b5c6f12c6983a955007ce3cf50c4191f0a2bcb8b700912bc7244",
    "leonardo-da-vinci": "a5c2bd6805d62204c14f552bb10e3d664be1e9e1a06cb7ecb7f416079f690da4",
    "mary-shelley": "24b084889421732a4b26e5ed3e65895c3dd9f6adbb14f4479c0a425be94b6fbb",
    "nicolaus-copernicus": "049edcae19224bf75e7a3a98058672c933c08a792e74584363cbd3a5a9ed171c",
    "thomas-jefferson": "de86302ad7b03571e3530cd71bad436f1fa82a0b1f6f50d2065fb2735e5cd247",
}
PROFILE_STYLESHEET_SHA256 = "94019c60b3ecc356760c629b5e2e2e0d8037a846955555a3a0634c9bae0113f5"
PAGES = {
    "index.html": "Project",
    "characters/index.html": "Characters",
    "docs/index.html": "Docs",
    "download/index.html": "Download",
    "contribute/index.html": "Contribute",
    **{
        f"characters/{slug}/index.html": "Characters"
        for slug in CHARACTER_PROFILES
    },
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
        "twelve source-informed historical character packs",
        "Character Wizard",
        "community library",
    ),
    "characters/index.html": (
        "twelve researched historical character packs",
        "candidate packs—not approved Official Catalog releases",
        "after exact-version catalog admission",
        "Public preinstallation requires exact-version approval",
        "source-informed educational interpretation",
        "Character Wizard",
        "community library",
        "untrusted declarative data",
        "Ada Lovelace",
        "Benjamin Franklin",
        "Elizabeth I",
        "Frederick Douglass",
        "Galileo Galilei",
        "George Washington",
        "Isaac Newton",
        "Jane Austen",
        "Leonardo da Vinci",
        "Mary Shelley",
        "Nicolaus Copernicus",
        "Thomas Jefferson",
        "AI-generated creative historical interpretations",
        "not authentic portraits",
        "not Official Catalog admission",
        "remain in development",
        "no Official Catalog Manifest exists yet",
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
    "span": frozenset({"class", "aria-hidden"}),
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
    "li": frozenset({"class"}),
    "small": frozenset(),
    "figure": frozenset({"class"}),
    "figcaption": frozenset(),
    "img": frozenset({"src", "alt", "width", "height", "loading", "decoding"}),
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
        self.elements: list[dict[str, object]] = []
        self.open_elements: list[int] = []

    def record_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.lower()
        normalized_attrs = [(key.lower(), value or "") for key, value in attrs]
        self.tags.append((normalized_tag, normalized_attrs))
        parent = self.open_elements[-1] if self.open_elements else None
        self.elements.append(
            {"tag": normalized_tag, "attrs": dict(normalized_attrs), "text": [], "parent": parent}
        )
        if normalized_tag not in {"meta", "link"}:
            self.open_elements.append(len(self.elements) - 1)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.record_starttag(tag, attrs)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.lower()
        normalized_attrs = [(key.lower(), value or "") for key, value in attrs]
        self.tags.append((normalized_tag, normalized_attrs))
        parent = self.open_elements[-1] if self.open_elements else None
        self.elements.append(
            {"tag": normalized_tag, "attrs": dict(normalized_attrs), "text": [], "parent": parent}
        )

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.lower()
        for index in range(len(self.open_elements) - 1, -1, -1):
            element_index = self.open_elements[index]
            if self.elements[element_index]["tag"] == normalized_tag:
                del self.open_elements[index:]
                return

    def handle_data(self, data: str) -> None:
        self.text.append(data)
        for element_index in self.open_elements:
            element_text = self.elements[element_index]["text"]
            assert isinstance(element_text, list)
            element_text.append(data)


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


def normalized_text(element: dict[str, object]) -> str:
    text = element["text"]
    assert isinstance(text, list)
    return " ".join(" ".join(text).split())


def element_attrs(element: dict[str, object]) -> dict[str, str]:
    attrs = element["attrs"]
    assert isinstance(attrs, dict)
    return attrs


def is_descendant(parser: PageParser, index: int, ancestor: int) -> bool:
    parent = parser.elements[index]["parent"]
    while isinstance(parent, int):
        if parent == ancestor:
            return True
        parent = parser.elements[parent]["parent"]
    return False


def is_visible(parser: PageParser, index: int) -> bool:
    current: int | None = index
    while isinstance(current, int):
        attrs = element_attrs(parser.elements[current])
        if "hidden" in attrs or attrs.get("aria-hidden", "").strip().lower() == "true":
            return False
        parent = parser.elements[current]["parent"]
        current = parent if isinstance(parent, int) else None
    return True


def scoped_elements(parser: PageParser, tag: str, ancestor: int | None = None) -> list[tuple[int, dict[str, object]]]:
    return [
        (index, element)
        for index, element in enumerate(parser.elements)
        if element["tag"] == tag and (ancestor is None or is_descendant(parser, index, ancestor))
    ]


def section_index(parser: PageParser, heading_id: str) -> int | None:
    for index, element in enumerate(parser.elements):
        if element["tag"] == "section" and element_attrs(element).get("aria-labelledby") == heading_id:
            return index
    return None


def semantic_links(parser: PageParser, ancestor: int | None = None) -> list[tuple[str, str]]:
    return [
        (element_attrs(element).get("href", ""), normalized_text(element))
        for _, element in scoped_elements(parser, "a", ancestor)
    ]


PROFILE_INTERPRETATION_DISCLOSURE = (
    "This is a source-informed educational creative interpretation of a historical person. "
    "It is not the person, a literal simulation, an authoritative reconstruction, an endorsed "
    "representative, or present-day expertise. Dramatic behavior is an interpretation, and "
    "generated dialogue is not a historical quotation. Consult reliable historical sources "
    "for the record."
)


def definition_fields(
    parser: PageParser,
    ancestor: int,
    errors: list[str],
    relative: str,
) -> dict[str, str]:
    dl_elements = scoped_elements(parser, "dl", ancestor)
    if len(dl_elements) != 1 or parser.elements[dl_elements[0][0]]["parent"] != ancestor:
        fail(errors, f"{relative}: profile facts require exactly one direct definition list")
        return {}

    dl_index = dl_elements[0][0]
    children = [
        element
        for element in parser.elements
        if element["parent"] == dl_index and element["tag"] in {"dt", "dd"}
    ]
    if len(children) != 8 or any(
        element["tag"] != ("dt" if position % 2 == 0 else "dd")
        for position, element in enumerate(children)
    ):
        fail(errors, f"{relative}: profile facts require four direct dt/dd pairs")
        return {}

    fields: dict[str, str] = {}
    for position in range(0, len(children), 2):
        term, description = children[position : position + 2]
        key = normalized_text(term)
        if key in fields:
            fail(errors, f"{relative}: profile facts contain duplicate field {key!r}")
            return {}
        fields[key] = normalized_text(description)
    return fields


def validate_character_index(parser: PageParser, errors: list[str]) -> None:
    cast_sections = [
        index
        for index, element in enumerate(parser.elements)
        if element["tag"] == "ul" and element_attrs(element).get("class") == "cast-grid"
    ]
    if len(cast_sections) != 1:
        fail(errors, "characters/index.html: expected one semantic cast grid")
        return
    links = semantic_links(parser, cast_sections[0])
    for slug, name in CHARACTER_PROFILES.items():
        expected = (f"/characters/{slug}/", name)
        if links.count(expected) != 1:
            fail(errors, f"characters/index.html: missing exact profile link for {name}")

        _, width, height, alt = PORTRAIT_ASSETS[slug]
        expected_image = {
            "src": f"/assets/portraits/{slug}.webp",
            "alt": alt,
            "width": str(width),
            "height": str(height),
            "decoding": "async",
        }
        images = [
            element_attrs(element)
            for _, element in scoped_elements(parser, "img", cast_sections[0])
            if element_attrs(element).get("src") == expected_image["src"]
        ]
        if images != [expected_image]:
            fail(errors, f"characters/index.html: missing reviewed portrait markup for {name}")


def validate_profile_contract(relative: str, slug: str, name: str, parser: PageParser, errors: list[str]) -> None:
    h1_text = [normalized_text(element) for _, element in scoped_elements(parser, "h1")]
    if h1_text != [name]:
        fail(errors, f"{relative}: h1 must be the canonical character name {name}")

    expected_url = f"{SITE_ORIGIN}/characters/{slug}/"
    links = [element_attrs(element) for _, element in scoped_elements(parser, "link")]
    if not any(attrs.get("rel") == "canonical" and attrs.get("href") == expected_url for attrs in links):
        fail(errors, f"{relative}: canonical URL does not match canonical slug")
    metas = [element_attrs(element) for _, element in scoped_elements(parser, "meta")]
    if not any(meta.get("property") == "og:url" and meta.get("content") == expected_url for meta in metas):
        fail(errors, f"{relative}: og:url does not match canonical slug")

    _, width, height, alt = PORTRAIT_ASSETS[slug]
    expected_image_path = f"/assets/portraits/{slug}.webp"
    profile_images = [element_attrs(element) for _, element in scoped_elements(parser, "img")]
    expected_image = {
        "src": expected_image_path,
        "alt": alt,
        "width": str(width),
        "height": str(height),
        "decoding": "async",
    }
    if profile_images != [expected_image]:
        fail(errors, f"{relative}: profile portrait must match the reviewed local asset and accessible alt text")
    expected_og_image = f"{SITE_ORIGIN}{expected_image_path}"
    if not any(meta.get("property") == "og:image" and meta.get("content") == expected_og_image for meta in metas):
        fail(errors, f"{relative}: og:image must use the reviewed local portrait")
    if not any(meta.get("property") == "og:image:alt" and meta.get("content") == alt for meta in metas):
        fail(errors, f"{relative}: og:image:alt must match the reviewed portrait description")

    ledes = [
        normalized_text(element)
        for _, element in scoped_elements(parser, "p")
        if element_attrs(element).get("class") == "lede"
    ]
    if len(ledes) != 1 or len(ledes[0]) < 60:
        fail(errors, f"{relative}: missing bounded educational summary")

    all_fact_asides = [
        index
        for index, element in scoped_elements(parser, "aside")
        if element_attrs(element).get("class") == "call-slip"
    ]
    fact_asides = [
        index
        for index in all_fact_asides
        if element_attrs(parser.elements[index]).get("aria-label") == f"{name} profile facts"
        and is_visible(parser, index)
    ]
    if len(all_fact_asides) != 1 or len(fact_asides) != 1:
        fail(errors, f"{relative}: expected one visible semantic profile facts block")
        fields: dict[str, str] = {}
    else:
        fields = definition_fields(parser, fact_asides[0], errors, relative)
    expected_fields = {
        "Historical horizon": PROFILE_HORIZONS[slug],
        "Catalog status": "Candidate pack in the verified local alpha",
        "Preinstallation": "Intended only after exact-version Official Catalog approval",
        "Portrait": "Published AI-generated creative historical interpretation; not an authentic portrait, and no endorsement is claimed",
    }
    field_errors = {
        "Historical horizon": "historical horizon field",
        "Catalog status": "candidate status field",
        "Preinstallation": "exact-version preinstallation field",
        "Portrait": "portrait field",
    }
    for term, expected_value in expected_fields.items():
        if fields.get(term) != expected_value:
            fail(errors, f"{relative}: missing semantic {field_errors[term]}")
    all_terms = [normalized_text(element) for _, element in scoped_elements(parser, "dt")]
    for term in expected_fields:
        if all_terms.count(term) != 1:
            fail(errors, f"{relative}: profile fact term {term!r} must appear exactly once")

    strengths = section_index(parser, "strengths-title")
    strength_items = [] if strengths is None else scoped_elements(parser, "li", strengths)
    if strengths is None or len(strength_items) < 5 or any(not normalized_text(item) for _, item in strength_items):
        fail(errors, f"{relative}: discussion-strength domains must be a semantic list")

    behavior = section_index(parser, "behavior-title")
    behavior_items = [] if behavior is None else [normalized_text(item) for _, item in scoped_elements(parser, "li", behavior)]
    if behavior_items != list(PROFILE_BEHAVIOR[slug]):
        fail(errors, f"{relative}: bounded behavior labels do not match the reviewed public mapping")

    all_interpretations = [
        index
        for index, element in scoped_elements(parser, "section")
        if element_attrs(element).get("aria-labelledby") == "interpretation-title"
    ]
    interpretations = [index for index in all_interpretations if is_visible(parser, index)]
    if len(all_interpretations) != 1 or len(interpretations) != 1:
        fail(errors, f"{relative}: expected one visible interpretation disclosure section")
    else:
        disclosure_paragraphs = [
            normalized_text(element)
            for _, element in scoped_elements(parser, "p", interpretations[0])
        ]
        if disclosure_paragraphs != [PROFILE_INTERPRETATION_DISCLOSURE]:
            fail(errors, f"{relative}: interpretation disclosure must match the canonical non-simulation statement")

    page_links = semantic_links(parser)
    required_links = {
        ("/characters/", "Back to all twelve"): "back link to Characters",
        ("/characters/#make-title", "Character Wizard roadmap"): "Wizard roadmap link",
        ("/characters/#community-title", "community library roadmap"): "community roadmap link",
    }
    for link, description in required_links.items():
        if page_links.count(link) != 1:
            fail(errors, f"{relative}: missing coherent {description}")

    main_elements = scoped_elements(parser, "main")
    visible = "" if not main_elements else normalized_text(main_elements[0][1])
    visible_digest = hashlib.sha256(visible.encode("utf-8")).hexdigest()
    if visible_digest != PROFILE_MAIN_TEXT_SHA256[slug]:
        fail(errors, f"{relative}: visible profile text differs from the reviewed release content")
    private_patterns = (
        (r"\b(?:agents|background|voice|relationships|scenarios|sources|provenance)\.md\b", "runtime prompt detail"),
        (r"\b(?:runtime|system)\s+prompt\b", "runtime prompt detail"),
        (r"(?:/users/|file://|\\users\\)", "private path detail"),
        (r"\b(?:initiative|interruption|verbosity|agreeableness|emotional(?:_|\s*)range|max(?:_|\s*)consecutive(?:_|\s*)turns)\s*[:=]\s*[0-9]", "hidden behavior number"),
    )
    for pattern, description in private_patterns:
        if re.search(pattern, visible, re.I):
            fail(errors, f"{relative}: exposed {description}")
    contradictory_claims = (
        (r"\b(?:this|the candidate|the pack|it)\s+is\s+(?:the person|a literal simulation)\b", "literal-simulation claim"),
        (r"\bofficial catalog release\s+(?:available|ready|published|for public installation)\b", "false Official Catalog release claim"),
        (r"\b(?:publicly installable|available for public installation)\b", "false public-installation claim"),
    )
    for pattern, description in contradictory_claims:
        if re.search(pattern, visible, re.I):
            fail(errors, f"{relative}: exposed {description}")


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

    for phrase in REQUIRED_LANGUAGE.get(relative, ()):
        if phrase.lower() not in lower:
            fail(errors, f"{relative}: missing required language: {phrase!r}")
    for phrase in FORBIDDEN_TEXT:
        if phrase in lower:
            fail(errors, f"{relative}: forbidden claim or collection language: {phrase!r}")

    if relative == "characters/index.html":
        validate_character_index(parser, errors)
    profile_match = re.fullmatch(r"characters/([a-z0-9-]+)/index\.html", relative)
    if profile_match:
        slug = profile_match.group(1)
        name = CHARACTER_PROFILES.get(slug)
        if name is None:
            fail(errors, f"{relative}: profile slug is not canonical")
        else:
            source_digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
            if source_digest != PROFILE_SOURCE_SHA256[slug]:
                fail(errors, f"{relative}: profile HTML differs from the reviewed release source")
            validate_profile_contract(relative, slug, name, parser, errors)


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
    actual_pages = {
        page.relative_to(site).as_posix()
        for page in site.rglob("*.html")
    }
    for unexpected in sorted(actual_pages - set(PAGES)):
        fail(errors, f"unexpected static HTML page outside the release gate: {unexpected}")
    for page in PAGES:
        validate_page(page, errors, site)

    primary_css = site / "assets/site.css"
    if not primary_css.is_file():
        fail(errors, "missing local stylesheet: assets/site.css")
    else:
        content = primary_css.read_text(encoding="utf-8")
        stylesheet_digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if stylesheet_digest != PROFILE_STYLESHEET_SHA256:
            fail(errors, "assets/site.css: stylesheet differs from the reviewed profile release source")
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

    portrait_directory = site / "assets/portraits"
    expected_portraits = {
        portrait_directory / f"{slug}.webp" for slug in PORTRAIT_ASSETS
    }
    actual_portraits = {
        path for path in portrait_directory.rglob("*") if path.is_file()
    } if portrait_directory.is_dir() else set()
    for unexpected in sorted(actual_portraits - expected_portraits):
        fail(errors, f"unexpected public portrait asset: {display_path(unexpected, site)}")
    for slug, (expected_digest, _, _, _) in PORTRAIT_ASSETS.items():
        portrait = portrait_directory / f"{slug}.webp"
        if not portrait.is_file():
            fail(errors, f"missing reviewed public portrait asset: assets/portraits/{slug}.webp")
            continue
        actual_digest = hashlib.sha256(portrait.read_bytes()).hexdigest()
        if actual_digest != expected_digest:
            fail(errors, f"assets/portraits/{slug}.webp: bytes differ from the reviewed asset digest")
    raster_assets = {
        path for path in site.rglob("*")
        if path.is_file() and path.suffix.lower() in {".webp", ".png", ".jpg", ".jpeg"}
    }
    for unexpected in sorted(raster_assets - expected_portraits):
        fail(errors, f"unexpected raster web asset outside portrait allowlist: {display_path(unexpected, site)}")

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

    headers_file = site / "_headers"
    if not headers_file.is_file():
        fail(errors, "missing static response policy: _headers")
    else:
        headers_source = headers_file.read_text(encoding="utf-8").lower()
        if "/*" not in headers_source or not re.search(
            r"cache-control\s*:\s*[^\n]*\bno-transform\b",
            headers_source,
        ):
            fail(errors, "_headers: every static response must use Cache-Control no-transform")

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
