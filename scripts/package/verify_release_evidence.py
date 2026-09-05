#!/usr/bin/env python3
# ruff: noqa: B904,F405
"""Independent, dependency-free verifier for a complete release-evidence directory."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import zipfile
from typing import Any

from release_evidence_common import *  # noqa: F403

EXPECTED_OUTPUTS = set(CHECKSUM_NAMES) | {"SHA256SUMS"}


def inventory_npm_packages(archive: zipfile.ZipFile) -> list[dict[str, Any]]:
    names = {item.filename for item in archive.infolist() if not item.is_dir()}
    output = []
    for name in sorted(names):
        if not name.startswith(NODE_MODULES) or not name.endswith("/package.json"):
            continue
        relative = name[len(NODE_MODULES) : -len("/package.json")]
        if not package_root(relative):
            continue
        try:
            metadata = json.loads(archive.read(name))
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail("npm_metadata_invalid", relative)
        if (
            not isinstance(metadata, dict)
            or not isinstance(metadata.get("name"), str)
            or not isinstance(metadata.get("version"), str)
        ):
            fail("npm_metadata_invalid", relative)
        if metadata["name"] != npm_name_for_path(relative):
            fail("npm_name_path_mismatch", relative)
        canonical_npm_purl(metadata["name"], metadata["version"])
        license_id = metadata.get("license")
        if not isinstance(license_id, str) or not license_id:
            if relative != "fs-ext":
                fail("npm_license_unknown", relative)
            license_id = "MIT"
        root = NODE_MODULES + relative + "/"
        license_paths = [
            item[len(APP_PREFIX) :]
            for item in sorted(names)
            if item.startswith(root)
            and "/" not in item[len(root) :]
            and re.match(
                r"^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.|$)", item.rsplit("/", 1)[-1], re.I
            )
        ]
        if not license_paths and relative != "abstract-logging":
            fail("npm_license_file_missing", relative)
        output.append(
            {
                "path": relative,
                "name": metadata.get("name"),
                "version": metadata.get("version"),
                "license": license_id,
                "licensePaths": license_paths,
            }
        )
    if len(output) != EXPECTED_NPM_PACKAGES or any(
        not isinstance(item["name"], str) or not isinstance(item["version"], str) for item in output
    ):
        fail("npm_package_count_invalid")
    return output


def inventory_personas(records: list[dict[str, Any]]) -> list[str]:
    roots = sorted(
        {
            item["path"].split("/")[5] + "/" + item["path"].split("/")[6]
            for item in records
            if item["path"].startswith("Contents/Resources/app/dist/personas/")
        }
    )
    if len(roots) != EXPECTED_PERSONAS:
        fail("persona_count_invalid")
    paths = {item["path"] for item in records}
    for root in roots:
        if (
            f"Contents/Resources/app/dist/personas/{root}/persona.yaml" not in paths
            or f"Contents/Resources/app/dist/personas/{root}/LICENSE" not in paths
        ):
            fail("persona_record_invalid", root)
    return roots


def load_json(path: pathlib.Path, code: str) -> tuple[dict[str, Any], bytes]:
    data = path.read_bytes()
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail(code)
    if not isinstance(value, dict) or data != canonical_json(value):
        fail(code)
    return value, data


def verify_checksums(root: pathlib.Path) -> None:
    data = (root / "SHA256SUMS").read_bytes()
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        fail("checksums_invalid")
    lines = text.splitlines(keepends=True)
    if len(lines) != len(CHECKSUM_NAMES) or any(not line.endswith("\n") for line in lines):
        fail("checksums_invalid")
    names = []
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._ -]+)\n", line)
        if match is None:
            fail("checksums_invalid")
        digest, name = match.groups()
        names.append(name)
        if name not in CHECKSUM_NAMES or sha256_file(root / name) != digest:
            fail("checksum_mismatch", name)
    if names != CHECKSUM_NAMES or len(names) != len(set(names)):
        fail("checksum_allowlist_invalid")


def verify_notices(
    path: pathlib.Path, packages: list[dict[str, Any]], personas_found: list[str]
) -> None:
    data = path.read_bytes()
    if b"\x00" in data or not data.startswith(b"THE GREEN ROOM \xe2\x80\x94 THIRD-PARTY NOTICES\n"):
        fail("notices_invalid")
    text = data.decode("utf-8")
    for marker in (
        "CPython 3.13.13\n",
        "PyYAML 6.0.3\n",
        "PyInstaller 6.16.0 build tool and bootloader exception\n",
    ):
        if text.count(marker) != 1:
            fail("notice_component_license_invalid", marker.strip())
    for expected in (CPYTHON_LICENSE_HASH, PYYAML_LICENSE_HASH, PYINSTALLER_LICENSE_HASH):
        if text.count(f"SHA-256: {expected}\n") != 1:
            fail("notice_component_license_hash_invalid", expected)
    for package in packages:
        marker = f"npm {package['name']}@{package['version']} [{package['path']}]\n"
        if text.count(marker) != max(1, len(package["licensePaths"])):
            fail("notice_package_coverage_invalid", package["path"])
    for persona in personas_found:
        if text.count(f"persona {persona}\n") != 1:
            fail("notice_persona_coverage_invalid", persona)
    for match in re.finditer(r"Source: ([^\n]+)\nSHA-256: ([0-9a-f]{64})\n-{78}\n", text):
        start = match.end()
        end = text.find("\n\n" + "=" * 78 + "\n", start)
        if end < 0:
            end = len(text.rstrip())
        body = text[start:end].rstrip().encode() + b"\n"
        if sha256_bytes(body) != match.group(2):
            fail("notice_license_hash_invalid", match.group(1))


def verify_spdx(
    spdx: dict[str, Any],
    records: list[dict[str, Any]],
    packages: list[dict[str, Any]],
    personas_found: list[str],
) -> None:
    required = {
        "spdxVersion",
        "dataLicense",
        "SPDXID",
        "name",
        "documentNamespace",
        "creationInfo",
        "documentDescribes",
        "packages",
        "files",
        "relationships",
        "annotations",
    }
    exact_keys(spdx, required, "spdx_schema_invalid")
    if (
        spdx["spdxVersion"] != "SPDX-2.3"
        or spdx["dataLicense"] != "CC0-1.0"
        or spdx["SPDXID"] != "SPDXRef-DOCUMENT"
    ):
        fail("spdx_identity_invalid")
    expected_namespace = (
        f"https://greenroomai.net/spdx/the-green-room/0.1.0-alpha.1/{ARTIFACT_SHA256}"
    )
    if spdx["documentNamespace"] != expected_namespace or spdx["documentDescribes"] != [
        "SPDXRef-Package-GreenRoom-Zip"
    ]:
        fail("spdx_namespace_invalid")
    file_rows = spdx["files"]
    if not isinstance(file_rows, list) or len(file_rows) != EXPECTED_FILES:
        fail("spdx_file_count_invalid")
    expected_files = {"./" + item["path"]: item for item in records}
    file_ids: set[str] = set()
    for item in file_rows:
        if not isinstance(item, dict) or set(item) != {
            "SPDXID",
            "fileName",
            "checksums",
            "licenseConcluded",
            "copyrightText",
            "comment",
        }:
            fail("spdx_file_invalid")
        expected = expected_files.pop(item["fileName"], None)
        if (
            expected is None
            or item["SPDXID"] != spdx_id("File", expected["path"])
            or item["checksums"]
            != [
                {"algorithm": "SHA1", "checksumValue": expected["sha1"]},
                {"algorithm": "SHA256", "checksumValue": expected["sha256"]},
            ]
            or item["comment"] != f"mode={expected['mode']:04o};bytes={expected['bytes']}"
        ):
            fail("spdx_file_invalid", item.get("fileName", ""))
        if item["SPDXID"] in file_ids:
            fail("spdx_duplicate_id")
        file_ids.add(item["SPDXID"])
    if expected_files:
        fail("spdx_file_omission")
    package_rows = spdx["packages"]
    if not isinstance(package_rows, list):
        fail("spdx_packages_invalid")
    ids = [item.get("SPDXID") for item in package_rows if isinstance(item, dict)]
    expected_package_count = 2 + 7 + EXPECTED_NPM_PACKAGES + EXPECTED_PERSONAS
    if len(package_rows) != expected_package_count or len(ids) != len(set(ids)):
        fail("spdx_package_count_invalid")
    by_id = {item["SPDXID"]: item for item in package_rows}
    mandatory = {
        "SPDXRef-Package-GreenRoom-Zip": (ARTIFACT_NAME, "0.1.0-alpha.1"),
        "SPDXRef-Package-GreenRoom-App": ("The Green Room.app", "0.1.0"),
        "SPDXRef-Package-Node": ("Node.js", "24.20.0"),
        "SPDXRef-Package-CPython": ("CPython", "3.13.13"),
        "SPDXRef-Package-Validator": ("greenroom-persona-validator", "0.1.0"),
        "SPDXRef-Package-PyYAML": ("PyYAML", "6.0.3"),
        "SPDXRef-Package-PyInstaller": ("PyInstaller", "6.16.0"),
        "SPDXRef-Package-Launcher": ("GreenRoomLauncher", "0.1.0"),
        "SPDXRef-Package-CredentialHelper": ("GreenRoomCredentialHelper", "0.1.0"),
    }
    for identifier, identity in mandatory.items():
        if (
            identifier not in by_id
            or (by_id[identifier].get("name"), by_id[identifier].get("versionInfo")) != identity
        ):
            fail("spdx_component_invalid", identifier)
    npm_ids = {spdx_id("NPM", package["path"]) for package in packages}
    external_ref_ids = {
        item.get("SPDXID")
        for item in package_rows
        if isinstance(item, dict) and "externalRefs" in item
    }
    if external_ref_ids != npm_ids:
        fail("spdx_external_refs_invalid")
    for package in packages:
        item = by_id.get(spdx_id("NPM", package["path"]))
        expected_ref = [
            {
                "referenceCategory": "PACKAGE-MANAGER",
                "referenceType": "purl",
                "referenceLocator": canonical_npm_purl(package["name"], package["version"]),
            }
        ]
        if (
            item is None
            or item.get("name") != package["name"]
            or item.get("versionInfo") != package["version"]
            or item.get("comment")
            != f"Exact shipped path: Contents/Resources/app/node_modules/{package['path']}"
            or item.get("externalRefs") != expected_ref
        ):
            fail("spdx_npm_invalid", package["path"])
    for persona in personas_found:
        item = by_id.get(spdx_id("Persona", persona))
        if (
            item is None
            or item.get("licenseDeclared") != "CC-BY-4.0"
            or item.get("licenseConcluded") != "CC-BY-4.0"
            or "not Official Catalog admission" not in item.get("comment", "")
        ):
            fail("spdx_persona_invalid", persona)
    relationships = spdx["relationships"]
    if not isinstance(relationships, list) or len(
        {
            (x.get("spdxElementId"), x.get("relationshipType"), x.get("relatedSpdxElement"))
            for x in relationships
            if isinstance(x, dict)
        }
    ) != len(relationships):
        fail("spdx_relationship_invalid")
    relation_set = {
        (x["spdxElementId"], x["relationshipType"], x["relatedSpdxElement"]) for x in relationships
    }
    if (
        ("SPDXRef-DOCUMENT", "DESCRIBES", "SPDXRef-Package-GreenRoom-Zip") not in relation_set
        or ("SPDXRef-Package-GreenRoom-Zip", "CONTAINS", "SPDXRef-Package-GreenRoom-App")
        not in relation_set
        or ("SPDXRef-Package-GreenRoom-App", "DEPENDS_ON", "SPDXRef-Package-Node")
        not in relation_set
        or ("SPDXRef-Package-GreenRoom-App", "DEPENDS_ON", "SPDXRef-Package-Validator")
        not in relation_set
        or ("SPDXRef-Package-Validator", "DEPENDS_ON", "SPDXRef-Package-CPython")
        not in relation_set
        or ("SPDXRef-Package-Validator", "DEPENDS_ON", "SPDXRef-Package-PyYAML") not in relation_set
        or ("SPDXRef-Package-PyInstaller", "BUILD_TOOL_OF", "SPDXRef-Package-Validator")
        not in relation_set
        or ("SPDXRef-Package-GreenRoom-Zip", "GENERATED_FROM", "SPDXRef-Package-GreenRoom-App")
        not in relation_set
        or ("SPDXRef-Package-GreenRoom-App", "CONTAINS", "SPDXRef-Package-PyInstaller")
        in relation_set
    ):
        fail("spdx_relationship_invalid")
    for identifier in file_ids | (
        set(by_id)
        - {
            "SPDXRef-Package-GreenRoom-Zip",
            "SPDXRef-Package-GreenRoom-App",
            "SPDXRef-Package-PyInstaller",
        }
    ):
        if ("SPDXRef-Package-GreenRoom-App", "CONTAINS", identifier) not in relation_set:
            fail("spdx_relationship_omission", identifier)
    for package in packages:
        identifier = spdx_id("NPM", package["path"])
        if ("SPDXRef-Package-GreenRoom-App", "DEPENDS_ON", identifier) not in relation_set:
            fail("spdx_dependency_omission", identifier)


def verify_evidence(value: dict[str, Any], document_hashes: dict[str, str]) -> None:
    exact_keys(
        value,
        {
            "schemaVersion",
            "artifact",
            "app",
            "components",
            "source",
            "toolchain",
            "signing",
            "notarization",
            "documents",
        },
        "evidence_schema_invalid",
    )
    if value["schemaVersion"] != 1 or value["artifact"] != {
        "name": ARTIFACT_NAME,
        "bytes": ARTIFACT_BYTES,
        "sha256": ARTIFACT_SHA256,
    }:
        fail("evidence_artifact_invalid")
    app = value["app"]
    if app != {
        "root": APP_ROOT,
        "archiveEntries": EXPECTED_ENTRIES,
        "regularFiles": EXPECTED_FILES,
        "directories": EXPECTED_DIRECTORIES,
        "treeSha256": FINAL_TREE_DIGEST,
        "manifestSchemaVersion": 2,
        "payloadFiles": EXPECTED_PAYLOAD,
        "signatureOwnedFiles": SIGNATURE_OWNED,
    }:
        fail("evidence_app_invalid")
    if value["components"] != {
        "npmPackagePaths": EXPECTED_NPM_PACKAGES,
        "personaRecords": EXPECTED_PERSONAS,
        "validatorFiles": EXPECTED_VALIDATOR_FILES,
        "nodeVersion": "24.20.0",
        "pythonVersion": "3.13.13",
        "validatorVersion": "0.1.0",
        "pyyamlVersion": "6.0.3",
        "pyinstallerVersion": "6.16.0",
    }:
        fail("evidence_components_invalid")
    if value["toolchain"] != {
        "target": "arm64-apple-darwin",
        "xcodeBuild": "17F113",
        "swift": "Apple Swift version 6.3.3",
        "clang": "Apple clang version 21.0.0 (clang-2100.1.1.101)",
        "node": "24.20.0",
        "python": "3.13.13",
        "npm": "11.19.0",
        "pyinstaller": "6.16.0",
    }:
        fail("evidence_toolchain_invalid")
    source = value["source"]
    if (
        set(source)
        != {
            "repository",
            "productCommit",
            "productTree",
            "protectedRef",
            "signingImplementationHead",
            "signingSquashMerge",
            "evidenceImplementation",
            "materials",
        }
        or source.get("repository") != "https://github.com/Jdelg718/the-green-room"
        or source.get("productCommit") != SOURCE_COMMIT
        or source.get("productTree") != SOURCE_TREE
        or source.get("protectedRef") != "refs/heads/main"
        or source.get("signingImplementationHead") != SIGNING_HEAD
        or source.get("signingSquashMerge") != SIGNING_MERGE
    ):
        fail("evidence_source_invalid")
    implementation = source.get("evidenceImplementation")
    if (
        not isinstance(implementation, dict)
        or implementation.get("baseCommit") != SIGNING_MERGE
        or implementation.get("state") not in {"committed", "uncommitted-working-tree"}
        or (implementation["state"] == "committed") != isinstance(implementation.get("commit"), str)
    ):
        fail("evidence_implementation_invalid")
    if isinstance(implementation.get("commit"), str) and not COMMIT.fullmatch(
        implementation["commit"]
    ):
        fail("evidence_implementation_invalid")
    expected_materials = {
        (SOURCE_COMMIT, "package-lock.json", PACKAGE_LOCK_HASH),
        (SOURCE_COMMIT, "uv.lock", UV_LOCK_HASH),
        (SOURCE_COMMIT, "pyproject.toml", PYPROJECT_HASH),
        (SOURCE_COMMIT, "package.json", SOURCE_PACKAGE_HASH),
        (SIGNING_HEAD, "package.json", FINAL_PACKAGE_HASH),
        (SOURCE_COMMIT, "scripts/package/build-validator.mjs", VALIDATOR_BUILD_SCRIPT_HASH),
        (SOURCE_COMMIT, "packaging/macos/validator.spec", VALIDATOR_SPEC_HASH),
    }
    materials = source.get("materials")
    if (
        not isinstance(materials, list)
        or {
            (x.get("commit"), x.get("path"), x.get("sha256"))
            for x in materials
            if isinstance(x, dict)
        }
        != expected_materials
    ):
        fail("evidence_materials_invalid")
    signing = value["signing"]
    if (
        set(signing)
        != {
            "identity",
            "teamId",
            "hardenedRuntime",
            "secureTimestamp",
            "requirements",
            "unsignedPayloadDigest",
            "preStapleTreeDigest",
            "finalTreeDigest",
        }
        or signing.get("identity") != SIGNING_IDENTITY
        or signing.get("teamId") != TEAM_ID
        or signing.get("hardenedRuntime") is not True
        or signing.get("secureTimestamp") is not True
        or not isinstance(signing.get("requirements"), dict)
        or set(signing["requirements"]) != {"app", "credentialHelper"}
        or signing.get("unsignedPayloadDigest") != UNSIGNED_DIGEST
        or signing.get("preStapleTreeDigest") != PRE_STAPLE_DIGEST
        or signing.get("finalTreeDigest") != FINAL_TREE_DIGEST
    ):
        fail("evidence_signing_invalid")
    notary = value["notarization"]
    if notary != {
        "submissionId": NOTARY_ID,
        "status": "Accepted",
        "acceptedStatusEvidenceSha256": STATUS_HASH,
        "acceptedPrivateLogSha256": PRIVATE_LOG_HASH,
        "privateLogIncluded": False,
    }:
        fail("evidence_notary_invalid")
    if value["documents"] != document_hashes:
        fail("evidence_document_hash_invalid")


def verify_provenance(
    value: dict[str, Any], root: pathlib.Path, evidence_implementation: dict[str, Any]
) -> None:
    exact_keys(
        value, {"_type", "subject", "predicateType", "predicate"}, "provenance_schema_invalid"
    )
    if (
        value["_type"] != "https://in-toto.io/Statement/v1"
        or value["predicateType"]
        != "https://greenroomai.net/attestations/release-evidence-assembly/v1"
    ):
        fail("provenance_identity_invalid")
    subjects = value["subject"]
    expected_names = CHECKSUM_NAMES[:-1]
    if (
        not isinstance(subjects, list)
        or [item.get("name") for item in subjects if isinstance(item, dict)] != expected_names
    ):
        fail("provenance_subject_invalid")
    for item in subjects:
        if item.get("digest") != {"sha256": sha256_file(root / item["name"])}:
            fail("provenance_subject_digest_invalid", item.get("name", ""))
    predicate = value["predicate"]
    if (
        set(predicate)
        != {"builder", "buildType", "invocation", "materials", "metadata", "evidenceImplementation"}
        or predicate.get("builder") != {"id": "local:Mothership"}
        or predicate.get("buildType")
        != "https://greenroomai.net/buildtypes/release-evidence-assembly/v1"
        or predicate.get("evidenceImplementation") != evidence_implementation
    ):
        fail("provenance_builder_invalid")
    if predicate.get("invocation") != {
        "environment": "local protected release workstation",
        "parameters": {"publication": False, "attestationExecuted": False},
    }:
        fail("provenance_invocation_invalid")
    materials = predicate.get("materials")
    expected_source = {
        (SOURCE_COMMIT, "package-lock.json", PACKAGE_LOCK_HASH),
        (SOURCE_COMMIT, "uv.lock", UV_LOCK_HASH),
        (SOURCE_COMMIT, "pyproject.toml", PYPROJECT_HASH),
        (SOURCE_COMMIT, "package.json", SOURCE_PACKAGE_HASH),
        (SIGNING_HEAD, "package.json", FINAL_PACKAGE_HASH),
        (SOURCE_COMMIT, "scripts/package/build-validator.mjs", VALIDATOR_BUILD_SCRIPT_HASH),
        (SOURCE_COMMIT, "packaging/macos/validator.spec", VALIDATOR_SPEC_HASH),
    }
    if (
        not isinstance(materials, list)
        or {
            (x.get("commit"), x.get("path"), x.get("sha256"))
            for x in materials[:-1]
            if isinstance(x, dict)
        }
        != expected_source
        or materials[-1] != {"uri": f"file:{ARTIFACT_NAME}", "digest": {"sha256": ARTIFACT_SHA256}}
    ):
        fail("provenance_materials_invalid")
    if predicate.get("metadata") != {
        "artifactBuildEpoch": 1788547103,
        "evidenceAssemblyDeterministic": True,
    }:
        fail("provenance_metadata_invalid")


def reject_private_material(root: pathlib.Path) -> None:
    forbidden_keys = {
        "password",
        "secret",
        "token",
        "apikey",
        "appleid",
        "keychainprofile",
        "privatelogpath",
        "rawlog",
    }
    for name in CHECKSUM_NAMES[1:]:
        data = (root / name).read_bytes()
        lower = data.lower()
        if (
            b"/users/" in lower
            or b"\\users\\" in lower
            or b"submission-1b9c51ee-280b-4349-9459-583e967651e8-log.private.json" in lower
        ):
            fail("private_path_forbidden", name)
        if name.endswith((".json", ".jsonl")):
            value = json.loads(data)

            def visit(item: Any) -> None:
                if isinstance(item, dict):
                    for key, child in item.items():
                        if key.lower() in forbidden_keys:
                            fail("private_field_forbidden", key)
                        visit(child)
                elif isinstance(item, list):
                    for child in item:
                        visit(child)

            visit(value)


def verify(root: pathlib.Path) -> None:
    if (
        not root.is_absolute()
        or pathlib.Path(os.path.abspath(root)) != root
        or root.is_symlink()
        or not root.is_dir()
    ):
        fail("evidence_root_invalid")
    entries = list(root.iterdir())
    if {path.name for path in entries} != EXPECTED_OUTPUTS or any(
        path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1 for path in entries
    ):
        fail("evidence_output_allowlist_invalid")
    verify_checksums(root)
    records, manifest_bytes = inspect_archive(root / ARTIFACT_NAME)
    validate_manifest(manifest_bytes, records)
    with zipfile.ZipFile(root / ARTIFACT_NAME) as archive:
        packages = inventory_npm_packages(archive)
    persona_paths = inventory_personas(records)
    verify_notices(root / "THIRD-PARTY-NOTICES.txt", packages, persona_paths)
    spdx, _ = load_json(root / CHECKSUM_NAMES[1], "spdx_invalid")
    verify_spdx(spdx, records, packages, persona_paths)
    notary, _ = load_json(root / "notarization-evidence.json", "notary_evidence_invalid")
    expected_notary = {
        "schemaVersion": 1,
        "submissionId": NOTARY_ID,
        "status": "Accepted",
        "acceptedStatusEvidenceSha256": STATUS_HASH,
        "acceptedLogSha256": PRIVATE_LOG_HASH,
        "acceptedLogInventoryVerified": True,
        "localCodeDirectoryHashInventoryBound": True,
        "ticketCodeObjectCountIncludingOuter": 8,
        "signedAppTreeDigestBefore": PRE_STAPLE_DIGEST,
        "signedAppFileCountBefore": 1340,
        "signedSourceStillUnstapledAndUnchanged": True,
        "unsignedAppDigestBeforeAndAfter": UNSIGNED_DIGEST,
        "unsignedAppFileCount": 1339,
        "finalZipPublished": True,
        "finalZipBytes": ARTIFACT_BYTES,
        "finalZipSha256": ARTIFACT_SHA256,
        "cleanExtractionAppTreeDigest": FINAL_TREE_DIGEST,
        "cleanExtractionFileCount": EXPECTED_FILES,
        "nestedCodeObjectCount": 7,
        "payloadFileCount": EXPECTED_PAYLOAD,
        "signatureOwnedFileCount": 3,
        "codesignDeepStrictVerified": True,
        "gatekeeperAcceptedNotarizedDeveloperId": True,
        "staplerValidated": True,
    }
    if notary != expected_notary:
        fail("notary_evidence_invalid")
    evidence, _ = load_json(root / "release-evidence.json", "release_evidence_invalid")
    document_hashes = {
        name: sha256_file(root / name)
        for name in (CHECKSUM_NAMES[1], "THIRD-PARTY-NOTICES.txt", "notarization-evidence.json")
    }
    verify_evidence(evidence, document_hashes)
    provenance, _ = load_json(root / "provenance.intoto.jsonl", "provenance_invalid")
    verify_provenance(provenance, root, evidence["source"]["evidenceImplementation"])
    reject_private_material(root)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=pathlib.Path)
    args = parser.parse_args()
    verify(args.evidence)
    print(
        json.dumps(
            {
                "code": "release_evidence_verified",
                "artifactSha256": ARTIFACT_SHA256,
                "regularFiles": EXPECTED_FILES,
                "npmPackagePaths": EXPECTED_NPM_PACKAGES,
                "personaRecords": EXPECTED_PERSONAS,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (EvidenceError, OSError) as error:
        print(
            json.dumps(
                {"code": "release_evidence_verification_failed", "message": str(error)},
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)
