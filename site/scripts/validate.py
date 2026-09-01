#!/usr/bin/env python3
"""Conservative, dependency-free release gate for the static greenroomai.net site."""

from __future__ import annotations

import hashlib
import re
import sys
# The SVG gate rejects declarations/entities before parsing repository-controlled assets.
import xml.etree.ElementTree as ET  # nosec B405
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
    "hal-finney": "Hal Finney",
    "isaac-newton": "Isaac Newton",
    "jane-austen": "Jane Austen",
    "john-maynard-keynes": "John Maynard Keynes",
    "leonardo-da-vinci": "Leonardo da Vinci",
    "len-sassaman": "Len Sassaman",
    "ludwig-von-mises": "Ludwig von Mises",
    "mary-shelley": "Mary Shelley",
    "milton-friedman": "Milton Friedman",
    "nicolaus-copernicus": "Nicolaus Copernicus",
    "thomas-jefferson": "Thomas Jefferson",
    "timothy-c-may": "Timothy C. May",
}
HELD_PROFILE_SLUGS = frozenset(
    {
        "hal-finney",
        "john-maynard-keynes",
        "len-sassaman",
        "ludwig-von-mises",
        "milton-friedman",
        "timothy-c-may",
    }
)
PROFILE_HORIZONS = {
    "ada-lovelace": "Through 26 November 1852",
    "benjamin-franklin": "Through 16 April 1790",
    "elizabeth-i": "Through 24 March 1603",
    "frederick-douglass": "Through 20 February 1895",
    "galileo-galilei": "Through 8 January 1642",
    "george-washington": "Through 14 December 1799",
    "hal-finney": "Through 25 March 2013",
    "isaac-newton": "Through 20 March 1727 (Old Style)",
    "jane-austen": "Through 17 July 1817",
    "john-maynard-keynes": "Through 22 July 1944",
    "leonardo-da-vinci": "Through 1 May 1519",
    "len-sassaman": "Through 17 February 2011",
    "ludwig-von-mises": "Through 14 September 1949",
    "mary-shelley": "Through 1 February 1851",
    "milton-friedman": "Through 8 November 2002",
    "nicolaus-copernicus": "Through 24 May 1543",
    "thomas-jefferson": "Through 4 July 1826",
    "timothy-c-may": "Through 31 December 1994",
}
PROFILE_BEHAVIOR = {
    "ada-lovelace": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "benjamin-franklin": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "elizabeth-i": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "frederick-douglass": ("Proactive initiative", "Rarely interrupts", "Expansive", "Independent", "Expressive range"),
    "galileo-galilei": ("Proactive initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "george-washington": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Restrained affect"),
    "hal-finney": ("Measured initiative", "Rarely interrupts", "Measured detail", "Collaborative", "Controlled range"),
    "isaac-newton": ("Measured initiative", "Rarely interrupts", "Measured detail", "Challenging", "Controlled range"),
    "jane-austen": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "john-maynard-keynes": ("Proactive initiative", "Rarely interrupts", "Expansive", "Independent", "Controlled range"),
    "leonardo-da-vinci": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "len-sassaman": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "ludwig-von-mises": ("Measured initiative", "Rarely interrupts", "Measured detail", "Challenging", "Restrained affect"),
    "mary-shelley": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Controlled range"),
    "milton-friedman": ("Proactive initiative", "Sometimes interrupts", "Measured detail", "Challenging", "Controlled range"),
    "nicolaus-copernicus": ("Measured initiative", "Rarely interrupts", "Measured detail", "Independent", "Restrained affect"),
    "thomas-jefferson": ("Measured initiative", "Rarely interrupts", "Expansive", "Independent", "Controlled range"),
    "timothy-c-may": ("Proactive initiative", "Sometimes interrupts", "Measured detail", "Challenging", "Controlled range"),
}
PORTRAIT_ASSETS = {
    "ada-lovelace": ("daa916a330fde6c45e6998e7cd447c205b71a89e28ef2e0ff890679f3566a5e2", 840, 1200, "AI-generated creative historical interpretation of Ada Lovelace in a dark study, wearing a high-collared black dress."),
    "benjamin-franklin": ("16951ccd809df29121a3417f344d4656320aef071a6cdf69138c89c9ca49e7c0", 768, 1024, "AI-generated creative historical interpretation of Benjamin Franklin in a brown coat, holding spectacles in a dim workshop."),
    "elizabeth-i": ("4436884480fe701940d8c9bd695940bc238e99ab71c65eacd9ba55fc4c77220c", 840, 1200, "AI-generated creative historical interpretation of Elizabeth I in a red embroidered gown and white ruff."),
    "frederick-douglass": ("e445dd92b3c36e4dff5bc920b408bfc239fabfe6f6ad60d0e22e4a4b93892b2b", 768, 1024, "AI-generated creative historical interpretation of Frederick Douglass with swept gray hair and a dark formal suit."),
    "galileo-galilei": ("81c1826e479b4b8b6357e69da3bd9142c34f7f47a8742b8386ce4b78b3603605", 840, 1200, "AI-generated creative historical interpretation of Galileo Galilei, white-bearded and seated beside books and a candle."),
    "george-washington": ("3883588e3ac035deed560893b1ddc1bca34c356c197c0094f179365d4b7a3a03", 768, 1024, "AI-generated creative historical interpretation of George Washington in a dark blue Continental-era coat beside surveying instruments."),
    "hal-finney": ("4afda0586162e6c7dbf71cee0e3af3006f7bfc4058e3175435aa78248c2fc6bb", 768, 1024, "AI-generated creative historical interpretation of Hal Finney with short graying hair and glasses in a dim engineering workspace."),
    "isaac-newton": ("b666032239adf370bfb187b612506466fabfa6d6d3272179d3055ef236c57466", 840, 1200, "AI-generated creative historical interpretation of Isaac Newton in a dark coat, seated at a candlelit desk."),
    "jane-austen": ("abf73e727337eb88b99dfbe2f318bced75e2ce9ef34689e96dd26758879345ea", 768, 1024, "AI-generated creative historical interpretation of Jane Austen in a modest cap and dark shawl beside a writing desk."),
    "john-maynard-keynes": ("c9a98d99cd6de58c5d8b5189111cb4d4898f8b567d49ed1935e5ac1d4d8290a1", 768, 1024, "AI-generated creative historical interpretation of John Maynard Keynes in a dark 1940s suit and bow tie beside an unmarked world map."),
    "leonardo-da-vinci": ("6340c0f43e05e46175bfaad85f200d4e8cd1be2754cac3f2a3843df294842acd", 840, 1200, "AI-generated creative historical interpretation of Leonardo da Vinci, white-bearded with one hand raised in thought."),
    "len-sassaman": ("7b126b0569ca82a19075b124158f64c593221699ae5b11158ba6c73db95c6b03", 768, 1024, "AI-generated creative historical interpretation of Len Sassaman with short dark hair, a beard, and glasses in a dim research workspace."),
    "ludwig-von-mises": ("90bdf9fe2d1e9a6b1f5926e197f1c5cf80dc7ee25d101fc2605dbc418d9d6170", 768, 1024, "AI-generated creative historical interpretation of Ludwig von Mises in a dark suit and round glasses at a dim seminar desk."),
    "mary-shelley": ("6030a58352b00b3fea02b7e950d2a58fa464c51efbdd453933e68312486a633f", 768, 1024, "AI-generated creative historical interpretation of Mary Shelley in a black period dress at a storm-lit writing desk."),
    "milton-friedman": ("90e95dfffcdc20693fc06f169ca5efeba18a135b0ea873872c3844bbd359c554", 768, 1024, "AI-generated creative historical interpretation of Milton Friedman in a dark suit and large glasses before an abstract economics chalkboard."),
    "nicolaus-copernicus": ("f7536c02c87c15fc238ca3b528bf4f17146cf814b3ffdbd486094948af1ebf6e", 768, 1024, "AI-generated creative historical interpretation of Nicolaus Copernicus in a red-and-black scholar’s robe beside astronomical notes."),
    "thomas-jefferson": ("1af3d4d7f72dc0f5d94f0f889bd14fca3a6c737c071c68e521580a4178b4fd06", 768, 1024, "AI-generated creative historical interpretation of Thomas Jefferson in a dark period coat in an architectural study."),
    "timothy-c-may": ("4117c268e92d8dfad6c9fed65b678ef0522b820a10d9f5794742e87a2fb0d46d", 768, 1024, "AI-generated creative historical interpretation of Timothy C. May with a graying beard and glasses in a dim semiconductor workshop."),
}
PROFILE_MAIN_TEXT_SHA256 = {
    "ada-lovelace": "29c6d82d8f3b8909bbf69f768e7f90338cd2bf78dd4bc9d14072c14aec4cd09e",
    "benjamin-franklin": "5bfb46cb1310184a1a24ee4c760cd4daf84f725330dca4616d06a9a6db126fec",
    "elizabeth-i": "dbf4324ad6f0548a1811a0b63e3b0846fa0dfba38d3c65dee6ac3021fe52c088",
    "frederick-douglass": "c5d7114bfa6549adcb9edc6082797bc799591730b24925cc8d0e154299ef8782",
    "galileo-galilei": "664407b46d2b37f6d6c208a1f69960015dde338b0fec4161d35326c0ba69c4b3",
    "george-washington": "1553d0aafc79076f46b31bc9b01f56b4b0620a10c3d6bf0fda773168a89d97b8",
    "hal-finney": "74a36411f98e50372df579273263ec9cab28afd3634346b04df918fdb1772702",
    "isaac-newton": "3ada6b152e241449bc82f9987440e0dd04f556ce2bb498365eb21999d6a35c39",
    "jane-austen": "feeac97a84bc4423ad365179a5063f00ca98c427d0824d73cf43ce6c2402d59d",
    "john-maynard-keynes": "0637c97aaad183a06a4a475c59e96abaa615fd17aa19c0bbc79552ebb580402c",
    "leonardo-da-vinci": "b0505daf7550c832e07d9f4eda3e6779ff54bdbd5ee8efc0d30e965a8a5f64d1",
    "len-sassaman": "9a09deb2372617d512012bb7b2c980efcd62a7fade46d669beab4c3c43e51bb1",
    "ludwig-von-mises": "e11eac2aec8a447c90c6ad7b361ba2ab68b93765b639f679a56d9cfd7331c0e4",
    "mary-shelley": "1778fd5051111634dd487e01365d6eceea369a685f5f10209ee9aeac433c675e",
    "milton-friedman": "301be702d02c1cae560337f0a09a70d7018d43ce8e55816e8df56cd70bb07e5a",
    "nicolaus-copernicus": "aae6dcbee4fa011c50b76099b3b41b236a2132f916d1232a458a19993417a652",
    "thomas-jefferson": "13fe4c9bc0a9ddbfab10d22928bf7266e1cbcacb1088bf8add56ddb1cf821d18",
    "timothy-c-may": "4919a7962b6d40168cdcb08d6f140e06ef13e95a2813134506d1998c13c0f861",
}
PROFILE_SOURCE_SHA256 = {
    "ada-lovelace": "e7c2c276f1ab868ab688f2922719a971ae47cd6b1d25dbdc5f85663301f2f943",
    "benjamin-franklin": "8abd2fddfe3c5d66a968aafd962983a528a7bc092f0480b1ae318fdd82054c40",
    "elizabeth-i": "9ffe1fb9c03c415ab61604d3266908bd0b2b4f4673d4f8a78bcbefb3bc4bed37",
    "frederick-douglass": "d1bc0f2b61eddf5fc3e79e9d13cdd18e1f6316e38e623759a78413e382834145",
    "galileo-galilei": "4bdca32485ab42f380fe15350cfd6c2014f6c2ea626cd7ad3f7dd6f350d9e33d",
    "george-washington": "9adb7ce455ee77bdbebf373baa9f4beb1bb514e1b3229baef3263fd5c112caef",
    "hal-finney": "d16baa32003161b4a174857ae9431c4f88feab0644633ae74046da81ab59ac75",
    "isaac-newton": "6524eb5de2a3d1eda7639e51128a25f63ece4c60d7c00cf84fb4d02bdca56b29",
    "jane-austen": "12eae66cb852bb0235d6cbbf44cfebdc6c98dd0b58b43f4d5aaf9e5cebb09a1f",
    "john-maynard-keynes": "4eff7ff3e66249a995b4a796b41d9650b034bf8352134c318ea1f5efa53fc1af",
    "leonardo-da-vinci": "dc1a192fb19214358d24ee3650c9036c32e345ca109ada3eed84623d210509fb",
    "len-sassaman": "3cd18fa90e0e70150113fb4e7f317155de14c5994c3d26a357ab5fb8fd252934",
    "ludwig-von-mises": "45efc6d14a7d2c10dd93d374dc0f601c9a5ecac4a31b558490d8aa58dd133bcf",
    "mary-shelley": "24591ac096c21b0306c7c2846c88b76b13c2016ab99b75cc5b7caea71a474e97",
    "milton-friedman": "bdb23ef0ffae1a650f9ab42ef72d48c50ea548b6a27ed04d97cbc2067a50d9ee",
    "nicolaus-copernicus": "08c8205630525ff437373eebd260a0215dc4cab22a42cdf213bf2fe0436a34f7",
    "thomas-jefferson": "19a8dfe761f40f8f5fc5e450a51d70042ff3390b43c52cd931ffe681f8e8ba3d",
    "timothy-c-may": "be8ba6dfc40540feeb9f3552ce71063d4e64dd311845165cd5da38685e3db9e0",
}
PROFILE_STYLESHEET_SHA256 = "e3dadfd5cc5907fbb36f48a0b926fba5e387bf289eb2dcdfadcdf66764ce4560"
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
        "eighteen public historical profiles",
        "twelve local-alpha candidates",
        "six additional profiles are approved for website presentation",
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
        "Hal Finney",
        "Isaac Newton",
        "Jane Austen",
        "John Maynard Keynes",
        "Leonardo da Vinci",
        "Len Sassaman",
        "Ludwig von Mises",
        "Mary Shelley",
        "Milton Friedman",
        "Nicolaus Copernicus",
        "Thomas Jefferson",
        "Timothy C. May",
        "AI-generated creative historical interpretations",
        "not authentic portraits",
        "not Official Catalog admission",
        "remain in development",
        "no Official Catalog Manifest exists yet",
        "approved for website presentation",
        "Website presentation is not runtime activation",
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
    "website presentation review only",
    "await human visual approval",
    "remains a candidate until a human approves",
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
            if not isinstance(element_text, list):
                raise TypeError("parser element text invariant failed")
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
    parsed = urlparse(compact_url(value))
    target, target_error = resolve_local_target(site, page, value)
    if target_error:
        fail(errors, f"{label}: local reference escapes site root: {value}")
    elif target is not None and not target.exists():
        fail(errors, f"{label}: broken local reference: {value}")
    elif parsed.fragment:
        fragment_target = target or page.resolve()
        if fragment_target.suffix.lower() != ".html" or not fragment_target.is_file():
            fail(errors, f"{label}: broken local fragment: {value}")
            return
        target_parser = PageParser()
        target_parser.feed(fragment_target.read_text(encoding="utf-8"))
        target_parser.close()
        target_ids = {
            element_attrs(element).get("id", "")
            for element in target_parser.elements
            if element_attrs(element).get("id")
        }
        if unquote(parsed.fragment) not in target_ids:
            fail(errors, f"{label}: broken local fragment: {value}")


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
        validate_local_reference(label, value, errors, site, page)
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
    if not isinstance(text, list):
        raise TypeError("parser element text invariant failed")
    return " ".join(" ".join(text).split())


def element_attrs(element: dict[str, object]) -> dict[str, str]:
    attrs = element["attrs"]
    if not isinstance(attrs, dict):
        raise TypeError("parser element attribute invariant failed")
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
    cast_section = cast_sections[0]
    cast_cards = [
        index
        for index, element in scoped_elements(parser, "li", cast_section)
        if "cast-card" in element_attrs(element).get("class", "").split()
        and element["parent"] == cast_section
    ]
    if len(cast_cards) != len(CHARACTER_PROFILES):
        fail(errors, "characters/index.html: expected exactly 18 cast cards")

    links = semantic_links(parser, cast_section)
    for slug, name in CHARACTER_PROFILES.items():
        expected = (f"/characters/{slug}/", name)
        if links.count(expected) != 1:
            fail(errors, f"characters/index.html: missing exact profile link for {name}")

        matching_cards = [
            card
            for card in cast_cards
            if semantic_links(parser, card).count(expected) == 1
        ]
        if len(matching_cards) != 1:
            fail(errors, f"characters/index.html: expected one cast card for {name}")
        elif slug in HELD_PROFILE_SLUGS:
            status_labels = [
                index
                for index, element in scoped_elements(parser, "small", matching_cards[0])
                if normalized_text(element) == "Website presentation approved · non-runtime hold"
            ]
            if len(status_labels) != 1:
                fail(errors, f"characters/index.html: missing held status label for {name}")
            elif not is_visible(parser, status_labels[0]):
                fail(errors, f"characters/index.html: missing visible held status label for {name}")

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
            for _, element in scoped_elements(parser, "img", cast_section)
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
    if slug in HELD_PROFILE_SLUGS:
        expected_fields = {
            "Historical horizon": PROFILE_HORIZONS[slug],
            "Catalog status": "Website presentation approved under non-runtime hold",
            "Preinstallation": "Not activated, built in, preinstalled, redistributed, or catalog-admitted",
            "Portrait": "Approved AI-generated creative historical interpretation for website presentation; not authentic, and no endorsement is claimed",
        }
    else:
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
        ("/characters/", "Back to all profiles"): "back link to Characters",
        ("/characters/#community-title", "community library roadmap"): "community roadmap link",
    }
    if slug in HELD_PROFILE_SLUGS:
        required_links[("/characters/#review-title", "Artwork review boundary")] = "artwork review link"
    else:
        required_links[("/characters/#make-title", "Character Wizard roadmap")] = "Wizard roadmap link"
    for link, description in required_links.items():
        if page_links.count(link) != 1:
            fail(errors, f"{relative}: missing coherent {description}")

    main_elements = scoped_elements(parser, "main")
    visible = "" if not main_elements else normalized_text(main_elements[0][1])
    visible_digest = hashlib.sha256(visible.encode("utf-8")).hexdigest()
    if visible_digest != PROFILE_MAIN_TEXT_SHA256[slug]:
        fail(
            errors,
            f"{relative}: visible profile text differs from the reviewed release content ({visible_digest})",
        )
    private_patterns = (
        (r"\b(?:agents|background|voice|relationships|scenarios|sources|provenance)\.md\b", "runtime prompt detail"),
        (r"\b(?:runtime|system)\s+prompt\b", "runtime prompt detail"),
        (r"(?:/(?:users|opt|home)/|file://|\\users\\)", "private path detail"),
        (r"\b(?:api[_ -]?key|password|credential|secret|bearer token)\s*[:=]", "credential detail"),
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

    public_safety_patterns = (
        (r"\b(?:Hal Finney|Len Sassaman) was Satoshi Nakamoto\b", "Satoshi identity speculation"),
        (r"\b(?:steps?|instructions?|guide)\s+(?:to|for)\s+(?:launder|evade|steal|hack|bypass)\b", "operational criminal guidance"),
        (r"\bthis is (?:investment|financial) advice\b|\b(?:you should|I recommend)\s+buy\b|\bbuy (?:this|the) asset now\b", "financial advice"),
        (r"\bKeynes (?:invented|created|originated) fiat money\b|\bfiat money (?:is|was) based on Keynes\b", "fiat-money misconception"),
    )
    for pattern, description in public_safety_patterns:
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
                fail(
                    errors,
                    f"{relative}: profile HTML differs from the reviewed release source ({source_digest})",
                )
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
        # The precheck above rejects DTD/entity declarations before ElementTree sees input.
        root = ET.fromstring(source)  # nosec B314
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


def webp_dimensions(data: bytes) -> tuple[int, int] | None:
    """Read canvas dimensions from a bounded RIFF WebP without image dependencies."""
    if len(data) < 20 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    offset = 12
    while offset + 8 <= len(data):
        chunk_type = data[offset : offset + 4]
        chunk_size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        payload_start = offset + 8
        payload_end = payload_start + chunk_size
        if payload_end > len(data):
            return None
        payload = data[payload_start:payload_end]
        if chunk_type == b"VP8X" and len(payload) >= 10:
            width = 1 + int.from_bytes(payload[4:7], "little")
            height = 1 + int.from_bytes(payload[7:10], "little")
            return width, height
        if chunk_type == b"VP8 " and len(payload) >= 10 and payload[3:6] == b"\x9d\x01\x2a":
            width = int.from_bytes(payload[6:8], "little") & 0x3FFF
            height = int.from_bytes(payload[8:10], "little") & 0x3FFF
            return width, height
        if chunk_type == b"VP8L" and len(payload) >= 5 and payload[0] == 0x2F:
            bits = int.from_bytes(payload[1:5], "little")
            width = 1 + (bits & 0x3FFF)
            height = 1 + ((bits >> 14) & 0x3FFF)
            return width, height
        offset = payload_end + (chunk_size % 2)
    return None


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
            fail(
                errors,
                "assets/site.css: stylesheet differs from the reviewed profile release source "
                f"({stylesheet_digest})",
            )
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
    for slug, (expected_digest, expected_width, expected_height, _) in PORTRAIT_ASSETS.items():
        portrait = portrait_directory / f"{slug}.webp"
        if not portrait.is_file():
            fail(errors, f"missing reviewed public portrait asset: assets/portraits/{slug}.webp")
            continue
        portrait_bytes = portrait.read_bytes()
        actual_digest = hashlib.sha256(portrait_bytes).hexdigest()
        if actual_digest != expected_digest:
            fail(errors, f"assets/portraits/{slug}.webp: bytes differ from the reviewed asset digest")
        dimensions = webp_dimensions(portrait_bytes)
        if dimensions != (expected_width, expected_height):
            fail(
                errors,
                f"assets/portraits/{slug}.webp: dimensions differ from the reviewed asset record",
            )
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
        required_headers = {
            "content-security-policy:": (
                "default-src 'self'",
                "connect-src 'none'",
                "form-action 'none'",
                "frame-ancestors 'none'",
                "object-src 'none'",
            ),
            "referrer-policy:": ("no-referrer",),
            "x-content-type-options:": ("nosniff",),
            "permissions-policy:": ("camera=()", "microphone=()", "payment=()"),
        }
        for header, directives in required_headers.items():
            if header not in headers_source or not all(
                directive in headers_source for directive in directives
            ):
                fail(errors, f"_headers: missing restrictive {header[:-1]} policy")

    readme = site / "README.md"
    if not readme.is_file():
        fail(errors, "missing site README")
    else:
        readme_text = readme.read_text(encoding="utf-8").lower()
        if "## deployment contract" not in readme_text:
            fail(errors, "README: missing deployment contract")
        if "must not redeploy" not in readme_text:
            fail(errors, "README: missing source-integration no-redeploy boundary")
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
