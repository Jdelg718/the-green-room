#!/usr/bin/env python3
"""Deterministic negative tests for the static-site release gate."""

from __future__ import annotations

import tempfile
import unittest
import shutil
from pathlib import Path

import validate


EXPECTED_PROFILES = {
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


class StaticPolicyTests(unittest.TestCase):
    def assert_rejected(self, errors: list[str], reason: str) -> None:
        self.assertTrue(errors, "unsafe fixture unexpectedly passed validation")
        self.assertTrue(
            any(reason in error for error in errors),
            f"expected rejection containing {reason!r}, got: {errors}",
        )

    def test_current_site_passes(self) -> None:
        self.assertEqual(validate.collect_errors(), [])

    def test_all_canonical_character_profile_routes_are_release_gated(self) -> None:
        self.assertEqual(
            getattr(validate, "CHARACTER_PROFILES", {}),
            EXPECTED_PROFILES,
        )
        expected_pages = {
            f"characters/{slug}/index.html" for slug in EXPECTED_PROFILES
        }
        self.assertTrue(expected_pages.issubset(validate.PAGES))

    def test_character_index_requires_one_semantic_profile_link_per_cast_member(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "characters" / "index.html"
            source = page.read_text(encoding="utf-8")
            source = source.replace(
                '<a href="/characters/ada-lovelace/">Ada Lovelace</a>',
                '<span>Ada Lovelace</span><a href="/characters/benjamin-franklin/">Profile</a>',
            )
            page.write_text(source, encoding="utf-8")
            self.assert_rejected(validate.collect_errors(site), "profile link for Ada Lovelace")

    def test_profile_fields_must_be_semantic_not_incidental_text(self) -> None:
        mutations = {
            "historical horizon field": (
                "<dt>Historical horizon</dt>",
                "<p>Historical horizon</p>",
            ),
            "candidate status field": (
                "<dt>Catalog status</dt>",
                "<p>Catalog status</p>",
            ),
            "portrait field": (
                "<dt>Portrait</dt>",
                "<p>Portrait</p>",
            ),
            "Wizard roadmap link": (
                '<a href="/characters/#make-title">Character Wizard roadmap</a>',
                '<span>Character Wizard roadmap</span>',
            ),
            "community roadmap link": (
                '<a href="/characters/#community-title">community library roadmap</a>',
                '<span>community library roadmap</span>',
            ),
        }
        for reason, (required, replacement) in mutations.items():
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as temporary:
                site = Path(temporary) / "site"
                shutil.copytree(validate.SITE, site)
                page = site / "characters" / "ada-lovelace" / "index.html"
                if not page.is_file():
                    self.fail("missing Ada Lovelace profile fixture")
                source = page.read_text(encoding="utf-8")
                self.assertIn(required, source)
                page.write_text(source.replace(required, replacement), encoding="utf-8")
                self.assert_rejected(validate.collect_errors(site), reason)

    def test_profiles_reject_private_pack_details_and_false_release_claims(self) -> None:
        fixtures = {
            "runtime prompt detail": "<p>AGENTS.md contains the runtime prompt.</p>",
            "hidden behavior number": "<p>initiative: 0.5</p>",
            "forbidden claim": "<p>Download now from the public installer.</p>",
        }
        for reason, injection in fixtures.items():
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as temporary:
                site = Path(temporary) / "site"
                shutil.copytree(validate.SITE, site)
                page = site / "characters" / "ada-lovelace" / "index.html"
                if not page.is_file():
                    self.fail("missing Ada Lovelace profile fixture")
                source = page.read_text(encoding="utf-8")
                page.write_text(source.replace("</main>", f"{injection}</main>"), encoding="utf-8")
                self.assert_rejected(validate.collect_errors(site), reason)

    def test_profile_status_cannot_be_satisfied_by_hidden_duplicate_facts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "characters" / "ada-lovelace" / "index.html"
            source = page.read_text(encoding="utf-8")
            source = source.replace(
                "<dt>Catalog status</dt><dd>Candidate pack in the verified local alpha</dd>",
                "<dt>Catalog status</dt><dd>Official Catalog release available for public installation</dd>",
                1,
            )
            hidden_duplicate = (
                '<dl aria-hidden="true"><dt>Historical horizon</dt><dd>Through 26 November 1852</dd>'
                '<dt>Catalog status</dt><dd>Candidate pack in the verified local alpha</dd>'
                '<dt>Preinstallation</dt><dd>Intended only after exact-version Official Catalog approval</dd>'
                '<dt>Portrait</dt><dd>No portrait is published; item-specific rights, provenance, attribution, '
                'and catalog review remain required</dd></dl>'
            )
            page.write_text(source.replace("</main>", f"{hidden_duplicate}</main>"), encoding="utf-8")
            self.assert_rejected(validate.collect_errors(site), "candidate status field")

    def test_interpretation_disclosure_rejects_polarity_reversal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "characters" / "ada-lovelace" / "index.html"
            source = page.read_text(encoding="utf-8")
            source = source.replace(
                "It is not the person, a literal simulation",
                "It is the person, a literal simulation",
                1,
            )
            page.write_text(source, encoding="utf-8")
            self.assert_rejected(validate.collect_errors(site), "canonical non-simulation statement")

    def test_profiles_require_coherent_character_navigation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "characters" / "ada-lovelace" / "index.html"
            if not page.is_file():
                self.fail("missing Ada Lovelace profile fixture")
            source = page.read_text(encoding="utf-8")
            page.write_text(
                source.replace('<a href="/characters/">Back to all twelve</a>', '<span>Back to all twelve</span>'),
                encoding="utf-8",
            )
            self.assert_rejected(validate.collect_errors(site), "back link to Characters")

    def test_rejects_all_case_insensitive_event_handlers(self) -> None:
        for attribute in ("onfocus", "ONMOUSEOVER"):
            with self.subTest(attribute=attribute):
                errors: list[str] = []
                validate.validate_html_policy(
                    "fixture.html",
                    f'<a href="#safe" {attribute}="alert(1)">unsafe</a>',
                    errors,
                    validate.SITE,
                    validate.SITE / "index.html",
                )
                self.assert_rejected(errors, "event handler attribute")

    def test_rejects_active_svg_elements(self) -> None:
        errors: list[str] = []
        validate.validate_svg_source(
            "active.svg",
            '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="x"/></svg>',
            errors,
            validate.SITE,
            validate.SITE / "assets/active.svg",
        )
        self.assert_rejected(errors, "forbidden or unsupported SVG element")

    def test_rejects_svg_foreign_object(self) -> None:
        errors: list[str] = []
        validate.validate_svg_source(
            "foreign.svg",
            '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
            errors,
            validate.SITE,
            validate.SITE / "assets/foreign.svg",
        )
        self.assert_rejected(errors, "forbidden or unsupported SVG element")

    def test_rejects_remote_svg_reference(self) -> None:
        errors: list[str] = []
        validate.validate_svg_source(
            "remote.svg",
            '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/a.svg#x)"/></svg>',
            errors,
            validate.SITE,
            validate.SITE / "assets/remote.svg",
        )
        self.assert_rejected(errors, "unsafe SVG URL reference")

    def test_rejects_css_remote_url_and_import(self) -> None:
        fixtures = {
            "remote URL": ".x { background: url(https://evil.example/x.png); }",
            "@import": '@import "https://evil.example/x.css";',
        }
        for reason, source in fixtures.items():
            with self.subTest(reason=reason):
                errors: list[str] = []
                validate.validate_css_source(
                    "fixture.css",
                    source,
                    errors,
                    validate.SITE,
                    validate.SITE / "assets/fixture.css",
                )
                self.assert_rejected(errors, reason)

    def test_rejects_parent_directory_escape_even_when_target_exists(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            site = root / "site"
            site.mkdir()
            page = site / "index.html"
            page.write_text("fixture", encoding="utf-8")
            (root / "outside.css").write_text("fixture", encoding="utf-8")
            errors: list[str] = []
            validate.validate_html_policy(
                "index.html",
                '<link rel="stylesheet" href="../outside.css">',
                errors,
                site,
                page,
            )
            self.assert_rejected(errors, "escapes site root")

    def test_rejects_meta_refresh_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "index.html"
            page.write_text(
                page.read_text(encoding="utf-8").replace(
                    "</head>",
                    '<meta http-equiv="refresh" content="0;url=https://evil.example/"></head>',
                ),
                encoding="utf-8",
            )
            self.assert_rejected(validate.collect_errors(site), "unsupported meta http-equiv policy")

    def test_rejects_additional_linked_stylesheet_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            extra = site / "assets/extra.css"
            extra.write_text(
                ".x { background: url(https://evil.example/x.png); }",
                encoding="utf-8",
            )
            page = site / "index.html"
            page.write_text(
                page.read_text(encoding="utf-8").replace(
                    "</head>",
                    '<link rel="stylesheet" href="assets/extra.css"></head>',
                ),
                encoding="utf-8",
            )
            self.assert_rejected(validate.collect_errors(site), "remote URL found")

    def test_requires_no_transform_static_response_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            (site / "_headers").write_text(
                "/*\n  Cache-Control: public, max-age=0, must-revalidate\n",
                encoding="utf-8",
            )
            self.assert_rejected(validate.collect_errors(site), "no-transform")

    def test_requires_complete_cast_and_character_release_boundaries(self) -> None:
        fixtures = {
            "Ada Lovelace": ("Ada Lovelace", "Ada L."),
            "Benjamin Franklin": ("Benjamin Franklin", "Benjamin F."),
            "Elizabeth I": ("Elizabeth I", "Elizabeth"),
            "Frederick Douglass": ("Frederick Douglass", "Frederick D."),
            "Galileo Galilei": ("Galileo Galilei", "Galileo G."),
            "George Washington": ("George Washington", "George W."),
            "Isaac Newton": ("Isaac Newton", "Isaac N."),
            "Jane Austen": ("Jane Austen", "Jane A."),
            "Leonardo da Vinci": ("Leonardo da Vinci", "Leonardo"),
            "Mary Shelley": ("Mary Shelley", "Mary S."),
            "Nicolaus Copernicus": ("Nicolaus Copernicus", "Nicolaus C."),
            "Thomas Jefferson": ("Thomas Jefferson", "Thomas J."),
            "public redistribution waits": (
                "public redistribution waits",
                "public display is planned",
            ),
            "remain in development": (
                "remain in development",
                "will arrive later",
            ),
            "no Official Catalog Manifest exists yet": (
                "no Official Catalog Manifest exists yet",
                "catalog work continues",
            ),
            "candidate packs—not approved Official Catalog releases": (
                "candidate packs—not approved Official Catalog releases",
                "candidate packs—approved Official Catalog releases",
            ),
            "after exact-version catalog admission": (
                "after exact-version catalog admission",
                "after a future release",
            ),
            "Public preinstallation requires exact-version approval": (
                "Public preinstallation requires exact-version approval",
                "Public preinstallation is automatic",
            ),
        }
        for reason, (required, replacement) in fixtures.items():
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as temporary:
                site = Path(temporary) / "site"
                shutil.copytree(validate.SITE, site)
                page = site / "characters" / "index.html"
                source = page.read_text(encoding="utf-8")
                self.assertIn(required, source)
                page.write_text(source.replace(required, replacement), encoding="utf-8")
                self.assert_rejected(validate.collect_errors(site), reason)


if __name__ == "__main__":
    unittest.main()
