from __future__ import annotations

import copy
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

import jsonschema

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE_SCRIPTS = ROOT / "scripts" / "package"
sys.path.insert(0, str(PACKAGE_SCRIPTS))

import generate_release_evidence as generator  # noqa: E402
import release_evidence_common as common  # noqa: E402
import verify_release_evidence as verifier  # noqa: E402


def write_checksum_fixture(root: pathlib.Path) -> None:
    for name in common.CHECKSUM_NAMES:
        (root / name).write_bytes((name + "\n").encode())
    (root / "SHA256SUMS").write_text(
        "".join(
            f"{hashlib.sha256((root / name).read_bytes()).hexdigest()}  {name}\n"
            for name in common.CHECKSUM_NAMES
        )
    )


class ReleaseEvidencePrimitiveTests(unittest.TestCase):
    def test_retained_parent_no_replace_preserves_competing_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "source").write_text("reviewed")
            (root / "destination").write_text("competitor")
            parent_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaisesRegex(common.EvidenceError, "output_exists"):
                    generator.rename_no_replace("source", "destination", parent_fd)
            finally:
                os.close(parent_fd)
            self.assertEqual((root / "source").read_text(), "reviewed")
            self.assertEqual((root / "destination").read_text(), "competitor")

    def test_npm_package_roots_include_nested_versions_but_not_embedded_metadata(self) -> None:
        self.assertTrue(common.package_root("ajv"))
        self.assertTrue(common.package_root("@fastify/error"))
        self.assertTrue(common.package_root("ajv/node_modules/fast-uri"))
        self.assertFalse(common.package_root("nan/tools"))
        self.assertFalse(common.package_root("fast-uri/benchmark"))

    def test_npm_identity_maps_path_and_uses_canonical_segment_encoding(self) -> None:
        self.assertEqual(common.npm_name_for_path("@fastify/error"), "@fastify/error")
        self.assertEqual(
            common.npm_name_for_path("ajv/node_modules/fast-uri"),
            "fast-uri",
        )
        self.assertEqual(
            common.canonical_npm_purl("@fastify/error", "4.2.0"),
            "pkg:npm/%40fastify/error@4.2.0",
        )
        self.assertEqual(
            common.canonical_npm_purl("fast-uri", "3.1.6"),
            "pkg:npm/fast-uri@3.1.6",
        )
        for name in ("@fastify", "@fastify/", "fastify/error", "%40fastify/error"):
            with self.subTest(name=name), self.assertRaises(common.EvidenceError):
                common.canonical_npm_purl(name, "1.0.0")

    def test_archive_paths_reject_traversal_links_by_name_and_junk(self) -> None:
        for value in (
            "../x",
            "/absolute",
            "The Green Room.app/../x",
            "The Green Room.app\\x",
            "The Green Room.app//x",
            "The Green Room.app/.DS_Store",
        ):
            with self.subTest(value=value), self.assertRaises(common.EvidenceError):
                common.safe_parts(value)

    def test_checksum_allowlist_is_exact_and_ordered(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            write_checksum_fixture(root)
            verifier.verify_checksums(root)
            lines = (root / "SHA256SUMS").read_text().splitlines(keepends=True)
            for replacement in (lines[:-1], [*lines, lines[0]], list(reversed(lines))):
                (root / "SHA256SUMS").write_text("".join(replacement))
                with self.assertRaises(common.EvidenceError):
                    verifier.verify_checksums(root)
            write_checksum_fixture(root)
            (root / "SHA256SUMS").write_text(
                (root / "SHA256SUMS").read_text().replace("  ", " *", 1)
            )
            with self.assertRaises(common.EvidenceError):
                verifier.verify_checksums(root)

    def test_output_allowlist_rejects_extra_link_and_hardlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            write_checksum_fixture(root)
            (root / "extra").write_text("extra")
            with self.assertRaisesRegex(common.EvidenceError, "allowlist"):
                verifier.verify(root)
            (root / "extra").unlink()
            (root / common.ARTIFACT_NAME).unlink()
            (root / common.ARTIFACT_NAME).symlink_to(root / common.CHECKSUM_NAMES[1])
            with self.assertRaisesRegex(common.EvidenceError, "allowlist"):
                verifier.verify(root)
            (root / common.ARTIFACT_NAME).unlink()
            os.link(root / common.CHECKSUM_NAMES[1], root / common.ARTIFACT_NAME)
            with self.assertRaisesRegex(common.EvidenceError, "allowlist"):
                verifier.verify(root)


class GeneratedReleaseEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        configured = os.environ.get("GREENROOM_RELEASE_EVIDENCE")
        cls.evidence_root = pathlib.Path(configured) if configured else None
        if cls.evidence_root is None or not cls.evidence_root.is_dir():
            raise unittest.SkipTest("set GREENROOM_RELEASE_EVIDENCE for exact-candidate tests")
        cls.records, cls.manifest_bytes = common.inspect_archive(
            cls.evidence_root / common.ARTIFACT_NAME
        )
        with zipfile.ZipFile(cls.evidence_root / common.ARTIFACT_NAME) as archive:
            cls.packages = verifier.inventory_npm_packages(archive)
        cls.personas = verifier.inventory_personas(cls.records)
        cls.spdx = json.loads((cls.evidence_root / common.CHECKSUM_NAMES[1]).read_bytes())
        cls.evidence = json.loads((cls.evidence_root / "release-evidence.json").read_bytes())
        cls.provenance = json.loads((cls.evidence_root / "provenance.intoto.jsonl").read_bytes())
        cls.document_hashes = {
            name: common.sha256_file(cls.evidence_root / name)
            for name in (
                common.CHECKSUM_NAMES[1],
                "THIRD-PARTY-NOTICES.txt",
                "notarization-evidence.json",
            )
        }

    def test_complete_exact_candidate_verifies(self) -> None:
        verifier.verify(self.evidence_root)

    def test_committed_strict_json_schemas_accept_exact_documents_and_reject_extras(self) -> None:
        release_schema = json.loads((ROOT / "packaging/release-evidence.schema.json").read_bytes())
        spdx_schema = json.loads((ROOT / "packaging/spdx-2.3.schema.json").read_bytes())
        provenance_schema = json.loads(
            (ROOT / "packaging/release-evidence-provenance.schema.json").read_bytes()
        )
        jsonschema.Draft202012Validator(release_schema).validate(self.evidence)
        jsonschema.Draft202012Validator(provenance_schema).validate(self.provenance)
        jsonschema.Draft7Validator(spdx_schema).validate(self.spdx)
        invalid = copy.deepcopy(self.evidence)
        invalid["unexpected"] = True
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.Draft202012Validator(release_schema).validate(invalid)

    def test_final_inventory_and_manifest_are_exact(self) -> None:
        manifest = common.validate_manifest(self.manifest_bytes, self.records)
        self.assertEqual(len(self.records), 1341)
        self.assertEqual(len(manifest["payloadFiles"]), 1337)
        self.assertEqual(manifest["signatureOwnedFiles"], common.SIGNATURE_OWNED)
        self.assertEqual(len(self.packages), 52)
        self.assertEqual(len(self.personas), 19)

    def test_spdx_rejects_file_omission_duplicate_tamper_and_mode(self) -> None:
        cases = []
        omitted = copy.deepcopy(self.spdx)
        omitted["files"].pop()
        cases.append(omitted)
        duplicate = copy.deepcopy(self.spdx)
        duplicate["files"][-1] = duplicate["files"][0]
        cases.append(duplicate)
        tampered = copy.deepcopy(self.spdx)
        tampered["files"][0]["checksums"][0]["checksumValue"] = "0" * 64
        cases.append(tampered)
        mode = copy.deepcopy(self.spdx)
        mode["files"][0]["comment"] = mode["files"][0]["comment"].replace("0444", "0644")
        cases.append(mode)
        for value in cases:
            with self.subTest(), self.assertRaises(common.EvidenceError):
                verifier.verify_spdx(value, self.records, self.packages, self.personas)

    def test_spdx_rejects_namespace_relationship_component_and_all57_overclaim(self) -> None:
        namespace = copy.deepcopy(self.spdx)
        namespace["documentNamespace"] += "-other"
        relationship = copy.deepcopy(self.spdx)
        relationship["relationships"].pop()
        component = copy.deepcopy(self.spdx)
        component["packages"] = [
            item for item in component["packages"] if item["SPDXID"] != "SPDXRef-Package-PyYAML"
        ]
        all57 = copy.deepcopy(self.spdx)
        for index in range(5):
            extra = copy.deepcopy(all57["packages"][9])
            extra["SPDXID"] += f"-{index}"
            extra["name"] = f"uv-lock-only-{index}"
            all57["packages"].append(extra)
        for value in (namespace, relationship, component, all57):
            with self.subTest(), self.assertRaises(common.EvidenceError):
                verifier.verify_spdx(value, self.records, self.packages, self.personas)

    def test_spdx_npm_external_refs_are_canonical_exact_and_unique(self) -> None:
        npm_rows = [
            item for item in self.spdx["packages"] if item["SPDXID"].startswith("SPDXRef-NPM-")
        ]
        self.assertEqual(len(npm_rows), 52)
        scoped = next(item for item in npm_rows if item["name"] == "@fastify/error")
        self.assertEqual(
            scoped["externalRefs"],
            [
                {
                    "referenceCategory": "PACKAGE-MANAGER",
                    "referenceLocator": "pkg:npm/%40fastify/error@4.2.0",
                    "referenceType": "purl",
                }
            ],
        )

        mutations = []
        for locator, schema_rejects in (
            ("pkg:npm/%40fastify%2Ferror@4.2.0", True),
            ("pkg:npm/@fastify/error@4.2.0", True),
            ("pkg:npm/%40fastify/forwarded@4.2.0", False),
            ("pkg:npm/%40fastify/error@4.2.1", False),
        ):
            value = copy.deepcopy(self.spdx)
            row = next(item for item in value["packages"] if item["name"] == "@fastify/error")
            row["externalRefs"][0]["referenceLocator"] = locator
            mutations.append((value, schema_rejects))
        duplicate = copy.deepcopy(self.spdx)
        row = next(item for item in duplicate["packages"] if item["name"] == "@fastify/error")
        row["externalRefs"].append(copy.deepcopy(row["externalRefs"][0]))
        mutations.append((duplicate, True))

        spdx_schema = json.loads((ROOT / "packaging/spdx-2.3.schema.json").read_bytes())
        validator = jsonschema.Draft7Validator(spdx_schema)
        for value, schema_rejects in mutations:
            with self.subTest(), self.assertRaises(common.EvidenceError):
                verifier.verify_spdx(value, self.records, self.packages, self.personas)
            if schema_rejects:
                with self.subTest(), self.assertRaises(jsonschema.ValidationError):
                    validator.validate(value)

    def test_spdx_uses_truthful_dependency_build_tool_and_persona_license_relationships(
        self,
    ) -> None:
        relationships = {
            (item["spdxElementId"], item["relationshipType"], item["relatedSpdxElement"])
            for item in self.spdx["relationships"]
        }
        self.assertIn(
            ("SPDXRef-Package-GreenRoom-Zip", "GENERATED_FROM", "SPDXRef-Package-GreenRoom-App"),
            relationships,
        )
        self.assertIn(
            ("SPDXRef-Package-GreenRoom-App", "DEPENDS_ON", "SPDXRef-Package-Node"),
            relationships,
        )
        self.assertNotIn(
            ("SPDXRef-Package-GreenRoom-App", "CONTAINS", "SPDXRef-Package-PyInstaller"),
            relationships,
        )
        for persona in self.personas:
            row = next(
                item
                for item in self.spdx["packages"]
                if item["SPDXID"] == common.spdx_id("Persona", persona)
            )
            self.assertEqual(row["licenseDeclared"], "CC-BY-4.0")

    def test_release_manifest_rejects_wrong_source_locks_toolchain_signing_notary_and_stale_tree(
        self,
    ) -> None:
        mutations = [
            ("source", "productCommit", "0" * 40),
            ("source", "materials", []),
            ("toolchain", "node", "24.19.0"),
            ("signing", "teamId", "BADTEAM000"),
            ("signing", "preStapleTreeDigest", common.FINAL_TREE_DIGEST),
            ("signing", "finalTreeDigest", common.PRE_STAPLE_DIGEST),
            ("notarization", "status", "Invalid"),
            ("components", "npmPackagePaths", 57),
        ]
        for section, key, replacement in mutations:
            value = copy.deepcopy(self.evidence)
            value[section][key] = replacement
            with self.subTest(section=section, key=key), self.assertRaises(common.EvidenceError):
                verifier.verify_evidence(value, self.document_hashes)

    def test_release_manifest_rejects_document_rebound_and_private_fields(self) -> None:
        rebound = copy.deepcopy(self.document_hashes)
        rebound[common.CHECKSUM_NAMES[1]] = "0" * 64
        with self.assertRaises(common.EvidenceError):
            verifier.verify_evidence(self.evidence, rebound)
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            for name in common.CHECKSUM_NAMES[1:]:
                shutil.copyfile(self.evidence_root / name, root / name)
            value = json.loads((root / "release-evidence.json").read_bytes())
            value["source"]["privateLogPath"] = "/Users/example/private.json"
            (root / "release-evidence.json").write_bytes(common.canonical_json(value))
            with self.assertRaises(common.EvidenceError):
                verifier.reject_private_material(root)

    def test_notices_reject_missing_package_license_and_persona(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "notices"
            text = (self.evidence_root / "THIRD-PARTY-NOTICES.txt").read_text()
            package = self.packages[0]
            marker = f"npm {package['name']}@{package['version']} [{package['path']}]\n"
            path.write_text(text.replace(marker, "removed\n", 1))
            with self.assertRaises(common.EvidenceError):
                verifier.verify_notices(path, self.packages, self.personas)
            path.write_text(text.replace(f"persona {self.personas[0]}\n", "removed\n", 1))
            with self.assertRaises(common.EvidenceError):
                verifier.verify_notices(path, self.packages, self.personas)

    def test_provenance_rejects_different_bytes_repo_lineage_builder_and_type(self) -> None:
        mutations = []
        digest = copy.deepcopy(self.provenance)
        digest["subject"][0]["digest"]["sha256"] = "0" * 64
        mutations.append(digest)
        subject = copy.deepcopy(self.provenance)
        subject["subject"][0]["name"] = "substitute.zip"
        mutations.append(subject)
        builder = copy.deepcopy(self.provenance)
        builder["predicate"]["builder"]["id"] = "https://github.com/actions/runner"
        mutations.append(builder)
        source = copy.deepcopy(self.provenance)
        source["predicate"]["materials"][0]["commit"] = "0" * 40
        mutations.append(source)
        claim = copy.deepcopy(self.provenance)
        claim["predicateType"] = "https://slsa.dev/provenance/v1"
        mutations.append(claim)
        for value in mutations:
            with self.subTest(), self.assertRaises(common.EvidenceError):
                verifier.verify_provenance(
                    value, self.evidence_root, self.evidence["source"]["evidenceImplementation"]
                )

    def test_generator_refuses_to_clobber_existing_output(self) -> None:
        artifact = os.environ.get("GREENROOM_RELEASE_ARTIFACT")
        notary = os.environ.get("GREENROOM_NOTARIZATION_EVIDENCE")
        if artifact is None or notary is None:
            self.skipTest("set exact source inputs for generator no-clobber test")
        result = subprocess.run(  # noqa: S603 - exact interpreter and repository-owned script
            [
                sys.executable,
                str(PACKAGE_SCRIPTS / "generate_release_evidence.py"),
                "--artifact",
                artifact,
                "--notarization-evidence",
                notary,
                "--output",
                str(self.evidence_root),
                "--repository",
                str(ROOT),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("output_exists", result.stderr)


class ReleaseWorkflowTests(unittest.TestCase):
    def test_workflow_is_manual_protected_minimal_and_pinned(self) -> None:
        text = (ROOT / ".github/workflows/release-evidence-attest.yml").read_text()
        self.assertNotIn("push:", text)
        self.assertIn("workflow_dispatch:", text)
        self.assertIn("expected_sha:", text)
        self.assertIn('test "$DISPATCH_SHA" = "$EXPECTED_SHA"', text)
        self.assertIn("environment: macos-release", text)
        self.assertIn("github.ref == 'refs/heads/main'", text)
        self.assertIn("contents: read\n  id-token: write\n  attestations: write", text)
        self.assertEqual(text.count("actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6"), 2)
        self.assertIn(
            "sbom-path: ${{ inputs.evidence_directory }}/The-Green-Room-0.1.0-alpha.1.spdx.json",
            text,
        )
        self.assertEqual(
            text.count(
                "subject-path: ${{ inputs.evidence_directory }}/"
                "The-Green-Room-0.1.0-alpha.1-macos-arm64.zip"
            ),
            2,
        )
        self.assertIn("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", text)
        self.assertIn("release-evidence.sigstore.json", text)
        self.assertIn("sbom.sigstore.json", text)
        self.assertIn("The-Green-Room-0.1.0-alpha.1-macos-arm64.zip", text)
        self.assertIn("The-Green-Room-0.1.0-alpha.1.spdx.json", text)
        for forbidden in ("release upload", "gh release", "contents: write", "push-to-registry"):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
