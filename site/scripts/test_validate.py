#!/usr/bin/env python3
"""Deterministic negative tests for the static-site release gate."""

from __future__ import annotations

import tempfile
import unittest
import shutil
from pathlib import Path

import validate


class StaticPolicyTests(unittest.TestCase):
    def assert_rejected(self, errors: list[str], reason: str) -> None:
        self.assertTrue(errors, "unsafe fixture unexpectedly passed validation")
        self.assertTrue(
            any(reason in error for error in errors),
            f"expected rejection containing {reason!r}, got: {errors}",
        )

    def test_current_site_passes(self) -> None:
        self.assertEqual(validate.collect_errors(), [])

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


if __name__ == "__main__":
    unittest.main()
