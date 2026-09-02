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


class StaticPolicyTests(unittest.TestCase):
    def assert_rejected(self, errors: list[str], reason: str) -> None:
        self.assertTrue(errors, "unsafe fixture unexpectedly passed validation")
        self.assertTrue(
            any(reason in error for error in errors),
            f"expected rejection containing {reason!r}, got: {errors}",
        )

    def test_current_site_passes(self) -> None:
        self.assertEqual(validate.collect_errors(), [])

    def test_readme_requires_no_redeploy_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            readme = site / "README.md"
            source = readme.read_text(encoding="utf-8")
            readme.write_text(source.replace("must not redeploy", "does not publish"), encoding="utf-8")
            self.assert_rejected(validate.collect_errors(site), "no-redeploy boundary")

    def test_all_canonical_character_profile_routes_are_release_gated(self) -> None:
        self.assertEqual(
            getattr(validate, "CHARACTER_PROFILES", {}),
            EXPECTED_PROFILES,
        )
        expected_pages = {
            f"characters/{slug}/index.html" for slug in EXPECTED_PROFILES
        }
        self.assertTrue(expected_pages.issubset(validate.PAGES))
        self.assertEqual(len(validate.CHARACTER_PROFILES), 18)
        self.assertEqual(len(validate.PORTRAIT_ASSETS), 18)

    def test_new_profiles_reject_public_safety_and_accuracy_failures(self) -> None:
        fixtures = {
            "hal-finney": ("Satoshi identity speculation", "<p>Hal Finney was Satoshi Nakamoto.</p>"),
            "timothy-c-may": ("operational criminal guidance", "<p>Follow these steps to launder funds.</p>"),
            "len-sassaman": ("Satoshi identity speculation", "<p>Len Sassaman was Satoshi Nakamoto.</p>"),
            "ludwig-von-mises": ("financial advice", "<p>You should buy this asset now.</p>"),
            "milton-friedman": ("financial advice", "<p>This is investment advice: buy now.</p>"),
            "john-maynard-keynes": ("fiat-money misconception", "<p>Keynes invented fiat money.</p>"),
        }
        for slug, (reason, injection) in fixtures.items():
            with self.subTest(slug=slug), tempfile.TemporaryDirectory() as temporary:
                site = Path(temporary) / "site"
                shutil.copytree(validate.SITE, site)
                page = site / "characters" / slug / "index.html"
                self.assertTrue(page.is_file(), f"missing {slug} profile fixture")
                source = page.read_text(encoding="utf-8")
                page.write_text(source.replace("</main>", f"{injection}</main>"), encoding="utf-8")
                self.assert_rejected(validate.collect_errors(site), reason)

    def test_reviewed_portrait_dimensions_match_binary_files(self) -> None:
        for slug, (_, expected_width, expected_height, _) in validate.PORTRAIT_ASSETS.items():
            with self.subTest(slug=slug):
                portrait = validate.SITE / "assets" / "portraits" / f"{slug}.webp"
                self.assertEqual(
                    validate.webp_dimensions(portrait.read_bytes()),
                    (expected_width, expected_height),
                )

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

    def test_character_index_requires_exact_cards_and_promoted_status_labels(self) -> None:
        mutations = {
            "exactly 18 cast cards": (
                "</ul>",
                '<li class="cast-card"><a href="/characters/hal-finney/">Duplicate</a></li></ul>',
            ),
            "promoted status label for Hal Finney": (
                "Preinstalled candidate · not Official Catalog admitted",
                "Preinstalled candidate · not Official Catalog admitted — allegedly",
            ),
            "visible promoted status label for Hal Finney": (
                "<small>Preinstalled candidate · not Official Catalog admitted</small>",
                '<div aria-hidden="true"><small>Preinstalled candidate · not Official Catalog admitted</small></div>',
            ),
        }
        for reason, (old, new) in mutations.items():
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as temporary:
                site = Path(temporary) / "site"
                shutil.copytree(validate.SITE, site)
                page = site / "characters" / "index.html"
                source = page.read_text(encoding="utf-8")
                self.assertIn(old, source)
                page.write_text(source.replace(old, new, 1), encoding="utf-8")
                self.assert_rejected(validate.collect_errors(site), reason)

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
                '<dt>Preinstallation</dt><dd>Preinstalled separately from Official Catalog admission</dd>'
                '<dt>Portrait</dt><dd>Published AI-generated creative historical interpretation; not an authentic '
                'portrait, and no endorsement is claimed</dd></dl>'
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

    def test_profile_facts_reject_hidden_ancestor_and_extra_visible_call_slip(self) -> None:
        mutations = {
            "hidden canonical facts": (
                '<aside class="call-slip" aria-label="Ada Lovelace profile facts">',
                '<div aria-hidden="true"><aside class="call-slip" aria-label="Ada Lovelace profile facts">',
                "</aside>",
                "</aside></div>",
            ),
            "extra visible facts": (
                "</main>",
                '<aside class="call-slip" aria-label="Release facts"><h2>Release</h2><dl>'
                '<dt>Catalog status</dt><dd>Official Catalog release available for public installation</dd>'
                '</dl></aside></main>',
                "",
                "",
            ),
        }
        for label, (first, first_replacement, second, second_replacement) in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                site = Path(temporary) / "site"
                shutil.copytree(validate.SITE, site)
                page = site / "characters" / "ada-lovelace" / "index.html"
                source = page.read_text(encoding="utf-8")
                source = source.replace(first, first_replacement, 1)
                if second:
                    source = source.replace(second, second_replacement, 1)
                page.write_text(source, encoding="utf-8")
                self.assert_rejected(validate.collect_errors(site), "visible semantic profile facts block")

    def test_interpretation_rejects_hidden_ancestor_and_external_contradictions(self) -> None:
        fixtures = {
            "hidden interpretation": (
                '<section class="section split" aria-labelledby="interpretation-title">',
                '<div aria-hidden="true"><section class="section split" aria-labelledby="interpretation-title">',
                "</section>",
                "</section></div>",
                "visible interpretation disclosure section",
            ),
            "external literal simulation": (
                "</main>",
                "<p>This is the person, a literal simulation.</p></main>",
                "",
                "",
                "literal-simulation claim",
            ),
            "external Official release": (
                "</main>",
                "<p>Official Catalog release available for public installation.</p></main>",
                "",
                "",
                "false Official Catalog release claim",
            ),
        }
        for label, (first, first_replacement, second, second_replacement, reason) in fixtures.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                site = Path(temporary) / "site"
                shutil.copytree(validate.SITE, site)
                page = site / "characters" / "ada-lovelace" / "index.html"
                source = page.read_text(encoding="utf-8")
                source = source.replace(first, first_replacement, 1)
                if second:
                    source = source.replace(second, second_replacement, 1)
                page.write_text(source, encoding="utf-8")
                self.assert_rejected(validate.collect_errors(site), reason)

    def test_profiles_reject_any_unreviewed_visible_claim(self) -> None:
        claims = (
            "This profile is a literal simulation.",
            "Ada Lovelace is a literal simulation.",
            "This character is the person.",
            "This is an approved Official Catalog release.",
            "The pack is an Official Catalog release.",
            "The candidate is ready for public installation.",
            "The candidate can be installed publicly.",
        )
        for claim in claims:
            with self.subTest(claim=claim), tempfile.TemporaryDirectory() as temporary:
                site = Path(temporary) / "site"
                shutil.copytree(validate.SITE, site)
                page = site / "characters" / "ada-lovelace" / "index.html"
                source = page.read_text(encoding="utf-8")
                page.write_text(source.replace("</main>", f"<p>{claim}</p></main>"), encoding="utf-8")
                self.assert_rejected(validate.collect_errors(site), "visible profile text differs from the reviewed release content")

    def test_profiles_reject_markup_or_css_that_conceals_reviewed_meaning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "characters" / "ada-lovelace" / "index.html"
            source = page.read_text(encoding="utf-8")
            self.assertIn("It is not the person", source)
            page.write_text(
                source.replace("It is not the person", 'It is <span class="conceal-negation">not </span>the person', 1),
                encoding="utf-8",
            )
            self.assert_rejected(validate.collect_errors(site), "profile HTML differs from the reviewed release source")

        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            stylesheet = site / "assets" / "site.css"
            stylesheet.write_text(
                stylesheet.read_text(encoding="utf-8") + "\n.conceal-negation { display: none; }\n",
                encoding="utf-8",
            )
            self.assert_rejected(validate.collect_errors(site), "stylesheet differs from the reviewed profile release source")

    def test_profiles_require_coherent_character_navigation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "characters" / "ada-lovelace" / "index.html"
            if not page.is_file():
                self.fail("missing Ada Lovelace profile fixture")
            source = page.read_text(encoding="utf-8")
            page.write_text(
                source.replace('<a href="/characters/">Back to all profiles</a>', '<span>Back to all profiles</span>'),
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

    def test_rejects_broken_local_fragment_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "characters" / "hal-finney" / "index.html"
            source = page.read_text(encoding="utf-8")
            self.assertIn('/characters/#review-title', source)
            page.write_text(
                source.replace('/characters/#review-title', '/characters/#missing-review-title'),
                encoding="utf-8",
            )
            self.assert_rejected(validate.collect_errors(site), "broken local fragment")

        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "characters" / "hal-finney" / "index.html"
            source = page.read_text(encoding="utf-8")
            self.assertIn('href="#main"', source)
            page.write_text(
                source.replace('href="#main"', 'href="#missing-main"', 1),
                encoding="utf-8",
            )
            self.assert_rejected(validate.collect_errors(site), "broken local fragment")

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

    def test_requires_restrictive_static_security_headers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            headers = site / "_headers"
            source = headers.read_text(encoding="utf-8")
            headers.write_text(
                source.replace("frame-ancestors 'none'; ", ""),
                encoding="utf-8",
            )
            self.assert_rejected(
                validate.collect_errors(site),
                "restrictive content-security-policy policy",
            )

    def test_portrait_bytes_are_pinned_and_originals_are_not_public_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            portrait = site / "assets" / "portraits" / "ada-lovelace.webp"
            portrait.write_bytes(portrait.read_bytes() + b"mutation")
            self.assert_rejected(validate.collect_errors(site), "reviewed asset digest")

        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            original = site / "assets" / "portraits" / "ada-lovelace.png"
            original.write_bytes(b"not approved for the public site")
            errors = validate.collect_errors(site)
            self.assert_rejected(errors, "unexpected public portrait asset")
            self.assert_rejected(errors, "outside reviewed allowlist")

    def test_social_card_metadata_is_exact_and_unique(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "index.html"
            source = page.read_text(encoding="utf-8")
            duplicate = (
                '<meta property="og:image" '
                'content="https://greenroomai.net/assets/portraits/ada-lovelace.webp">\n  '
            )
            page.write_text(
                source.replace('<meta property="og:image"', duplicate + '<meta property="og:image"', 1),
                encoding="utf-8",
            )
            self.assert_rejected(
                validate.collect_errors(site),
                "missing unique exact og:image social-card metadata",
            )

    def test_character_portraits_require_reviewed_local_markup_and_alt_text(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary) / "site"
            shutil.copytree(validate.SITE, site)
            page = site / "characters" / "index.html"
            source = page.read_text(encoding="utf-8")
            source = source.replace(
                "AI-generated creative historical interpretation of Ada Lovelace in a dark study, wearing a high-collared black dress.",
                "Ada Lovelace",
                1,
            )
            page.write_text(source, encoding="utf-8")
            self.assert_rejected(validate.collect_errors(site), "reviewed portrait markup for Ada Lovelace")

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
            "AI-generated creative historical interpretations": (
                "AI-generated creative historical interpretations",
                "historical illustrations",
            ),
            "not authentic portraits": (
                "not authentic portraits",
                "authentic portraits",
            ),
            "not Official Catalog admission": (
                "not Official Catalog admission",
                "Official Catalog admission",
            ),
            "remain in development": (
                "remain in development",
                "will arrive later",
            ),
            "no Official Catalog Manifest exists yet": (
                "no Official Catalog Manifest exists yet",
                "catalog work continues",
            ),
            "candidate packs are preinstalled but are not approved Official Catalog releases": (
                "candidate packs are preinstalled but are not approved Official Catalog releases",
                "candidate packs are preinstalled and approved Official Catalog releases",
            ),
            "Official Catalog admission requires exact-version approval": (
                "Official Catalog admission requires exact-version approval",
                "Official Catalog admission is automatic",
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
