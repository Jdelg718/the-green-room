#!/usr/bin/env python3
# ruff: noqa: B904,E501,F405,RUF005,S324,S603
"""Deterministically assemble the external Alpha 1 release-evidence bundle."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from typing import Any

from release_evidence_common import *  # noqa: F403

SPDX_NAME = CHECKSUM_NAMES[1]
MIT_TEXT = """MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the \"Software\"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


def git_bytes(repository: pathlib.Path, commit: str, name: str) -> bytes:
    result = subprocess.run(
        ["/usr/bin/git", "show", f"{commit}:{name}"],
        cwd=repository,
        check=False,
        capture_output=True,
        timeout=30,
    )
    if result.returncode != 0:
        fail("source_material_unavailable", f"{commit}:{name}")
    return result.stdout


def verify_source_materials(repository: pathlib.Path) -> list[dict[str, str]]:
    requirements = [
        (SOURCE_COMMIT, "package-lock.json", PACKAGE_LOCK_HASH),
        (SOURCE_COMMIT, "uv.lock", UV_LOCK_HASH),
        (SOURCE_COMMIT, "pyproject.toml", PYPROJECT_HASH),
        (SOURCE_COMMIT, "package.json", SOURCE_PACKAGE_HASH),
        (SIGNING_HEAD, "package.json", FINAL_PACKAGE_HASH),
        (SOURCE_COMMIT, "scripts/package/build-validator.mjs", VALIDATOR_BUILD_SCRIPT_HASH),
        (SOURCE_COMMIT, "packaging/macos/validator.spec", VALIDATOR_SPEC_HASH),
    ]
    output = []
    for commit, name, expected in requirements:
        actual = sha256_bytes(git_bytes(repository, commit, name))
        if actual != expected:
            fail("source_material_hash_invalid", f"{commit}:{name}")
        output.append({"commit": commit, "path": name, "sha256": actual})
    return output


def archive_data(archive: zipfile.ZipFile, path: str) -> bytes:
    try:
        return archive.read(APP_PREFIX + path)
    except KeyError:
        fail("payload_file_missing", path)


def npm_packages(archive: zipfile.ZipFile) -> list[dict[str, Any]]:
    names = {item.filename for item in archive.infolist() if not item.is_dir()}
    packages = []
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
        declared = metadata.get("license")
        if not isinstance(declared, str) or not declared:
            if relative != "fs-ext":
                fail("npm_license_unknown", relative)
            declared = "MIT"
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
        packages.append(
            {
                "path": relative,
                "name": metadata["name"],
                "version": metadata["version"],
                "license": declared,
                "licensePaths": license_paths,
            }
        )
    if len(packages) != EXPECTED_NPM_PACKAGES:
        fail("npm_package_count_invalid")
    if len({item["path"] for item in packages}) != EXPECTED_NPM_PACKAGES:
        fail("npm_package_duplicate")
    return packages


def personas(records: list[dict[str, Any]]) -> list[dict[str, str]]:
    roots = sorted(
        {
            item["path"].split("/")[5] + "/" + item["path"].split("/")[6]
            for item in records
            if item["path"].startswith("Contents/Resources/app/dist/personas/")
        }
    )
    if len(roots) != EXPECTED_PERSONAS:
        fail("persona_count_invalid")
    output = []
    for root in roots:
        required = [
            f"Contents/Resources/app/dist/personas/{root}/{name}"
            for name in ("persona.yaml", "LICENSE")
        ]
        if not all(any(item["path"] == path for item in records) for path in required):
            fail("persona_record_invalid", root)
        output.append({"path": root, "name": root.split("/", 1)[1]})
    return output


def license_expression(value: str) -> str:
    aliases = {
        "MIT": "MIT",
        "ISC": "ISC",
        "BSD-3-Clause": "BSD-3-Clause",
        "Apache-2.0": "Apache-2.0",
    }
    if value not in aliases:
        fail("npm_license_expression_unknown", value)
    return aliases[value]


def make_notices(
    repository: pathlib.Path,
    archive: zipfile.ZipFile,
    packages: list[dict[str, Any]],
    persona_rows: list[dict[str, str]],
) -> bytes:
    sections: list[tuple[str, str, bytes]] = []
    sections.append(
        (
            "The Green Room",
            "Contents/Resources/licenses/GreenRoom-LICENSE.txt",
            archive_data(archive, "Contents/Resources/licenses/GreenRoom-LICENSE.txt"),
        )
    )
    sections.append(
        (
            "Node.js 24.20.0",
            "Contents/Resources/licenses/Node-LICENSE.txt",
            archive_data(archive, "Contents/Resources/licenses/Node-LICENSE.txt"),
        )
    )
    external_licenses = [
        ("CPython 3.13.13", "packaging/licenses/CPython-3.13.13-LICENSE.txt", CPYTHON_LICENSE_HASH),
        ("PyYAML 6.0.3", "packaging/licenses/PyYAML-6.0.3-LICENSE.txt", PYYAML_LICENSE_HASH),
        (
            "PyInstaller 6.16.0 build tool and bootloader exception",
            "packaging/licenses/PyInstaller-6.16.0-COPYING.txt",
            PYINSTALLER_LICENSE_HASH,
        ),
    ]
    for title, path, expected in external_licenses:
        data = (repository / path).read_bytes()
        if sha256_bytes(data) != expected:
            fail("locked_license_hash_invalid", path)
        sections.append((title, path, data))
    for package in packages:
        if package["licensePaths"]:
            for path in package["licensePaths"]:
                sections.append(
                    (
                        f"npm {package['name']}@{package['version']} [{package['path']}]",
                        path,
                        archive_data(archive, path),
                    )
                )
        else:
            sections.append(
                (
                    f"npm {package['name']}@{package['version']} [{package['path']}]",
                    "SPDX MIT text; package declares MIT and contains no license file",
                    MIT_TEXT.encode(),
                )
            )
    for persona in persona_rows:
        path = f"Contents/Resources/app/dist/personas/{persona['path']}/LICENSE"
        sections.append((f"persona {persona['path']}", path, archive_data(archive, path)))
    header = (
        "THE GREEN ROOM — THIRD-PARTY NOTICES\n"
        "Generated from the exact final macOS Alpha 1 payload. Repeated texts are retained so every shipped package path and persona record is auditable.\n\n"
    ).encode()
    body = bytearray(header)
    for title, source, data in sections:
        if b"\x00" in data:
            fail("license_text_invalid", source)
        text = data.decode("utf-8")
        normalized = text.rstrip().encode() + b"\n"
        body.extend(
            (
                "=" * 78
                + f"\n{title}\nSource: {source}\nSHA-256: {sha256_bytes(normalized)}\n"
                + "-" * 78
                + "\n"
            ).encode()
        )
        body.extend(normalized)
        body.extend(b"\n")
    return bytes(body)


def make_spdx(
    records: list[dict[str, Any]],
    packages: list[dict[str, Any]],
    persona_rows: list[dict[str, str]],
    notices_hash: str,
) -> dict[str, Any]:
    document = "SPDXRef-DOCUMENT"
    app = "SPDXRef-Package-GreenRoom-App"
    artifact = "SPDXRef-Package-GreenRoom-Zip"
    package_rows: list[dict[str, Any]] = [
        {
            "SPDXID": artifact,
            "name": ARTIFACT_NAME,
            "versionInfo": "0.1.0-alpha.1",
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": False,
            "licenseConcluded": "Apache-2.0",
            "licenseDeclared": "Apache-2.0",
            "copyrightText": "NOASSERTION",
            "checksums": [{"algorithm": "SHA256", "checksumValue": ARTIFACT_SHA256}],
        },
        {
            "SPDXID": app,
            "name": "The Green Room.app",
            "versionInfo": "0.1.0",
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": True,
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": "Apache-2.0",
            "copyrightText": "NOASSERTION",
            "packageVerificationCode": {
                "packageVerificationCodeValue": hashlib.sha1(
                    "".join(sorted(item["sha1"] for item in records)).encode()
                ).hexdigest()
            },
        },
    ]
    relationships = [
        {
            "spdxElementId": document,
            "relationshipType": "DESCRIBES",
            "relatedSpdxElement": artifact,
        },
        {"spdxElementId": artifact, "relationshipType": "CONTAINS", "relatedSpdxElement": app},
    ]
    components = [
        ("Node.js", "24.20.0", "SPDXRef-Package-Node", "NOASSERTION", "runtime"),
        ("CPython", "3.13.13", "SPDXRef-Package-CPython", "Python-2.0", "runtime"),
        (
            "greenroom-persona-validator",
            "0.1.0",
            "SPDXRef-Package-Validator",
            "Apache-2.0",
            "application",
        ),
        ("PyYAML", "6.0.3", "SPDXRef-Package-PyYAML", "MIT", "library"),
        (
            "PyInstaller",
            "6.16.0",
            "SPDXRef-Package-PyInstaller",
            "GPL-2.0-or-later WITH Bootloader-exception",
            "build-tool",
        ),
        ("GreenRoomLauncher", "0.1.0", "SPDXRef-Package-Launcher", "Apache-2.0", "application"),
        (
            "GreenRoomCredentialHelper",
            "0.1.0",
            "SPDXRef-Package-CredentialHelper",
            "Apache-2.0",
            "application",
        ),
    ]
    for name, version, identifier, license_id, purpose in components:
        package_rows.append(
            {
                "SPDXID": identifier,
                "name": name,
                "versionInfo": version,
                "downloadLocation": "NOASSERTION",
                "filesAnalyzed": False,
                "licenseConcluded": license_id,
                "licenseDeclared": license_id,
                "copyrightText": "NOASSERTION",
                "primaryPackagePurpose": "APPLICATION" if purpose == "application" else "LIBRARY",
                "comment": f"Evidence role: {purpose}",
            }
        )
        if identifier != "SPDXRef-Package-PyInstaller":
            relationships.append(
                {
                    "spdxElementId": app,
                    "relationshipType": "CONTAINS",
                    "relatedSpdxElement": identifier,
                }
            )
    relationships.extend(
        [
            {
                "spdxElementId": "SPDXRef-Package-PyInstaller",
                "relationshipType": "BUILD_TOOL_OF",
                "relatedSpdxElement": "SPDXRef-Package-Validator",
            },
            {
                "spdxElementId": artifact,
                "relationshipType": "GENERATED_FROM",
                "relatedSpdxElement": app,
            },
            {
                "spdxElementId": app,
                "relationshipType": "DEPENDS_ON",
                "relatedSpdxElement": "SPDXRef-Package-Node",
            },
            {
                "spdxElementId": app,
                "relationshipType": "DEPENDS_ON",
                "relatedSpdxElement": "SPDXRef-Package-Validator",
            },
            {
                "spdxElementId": "SPDXRef-Package-Validator",
                "relationshipType": "DEPENDS_ON",
                "relatedSpdxElement": "SPDXRef-Package-CPython",
            },
            {
                "spdxElementId": "SPDXRef-Package-Validator",
                "relationshipType": "DEPENDS_ON",
                "relatedSpdxElement": "SPDXRef-Package-PyYAML",
            },
        ]
    )
    for item in packages:
        identifier = spdx_id("NPM", item["path"])
        package_rows.append(
            {
                "SPDXID": identifier,
                "name": item["name"],
                "versionInfo": item["version"],
                "downloadLocation": "NOASSERTION",
                "filesAnalyzed": False,
                "licenseConcluded": license_expression(item["license"]),
                "licenseDeclared": license_expression(item["license"]),
                "copyrightText": "NOASSERTION",
                "externalRefs": [
                    {
                        "referenceCategory": "PACKAGE-MANAGER",
                        "referenceType": "purl",
                        "referenceLocator": f"pkg:npm/{item['name'].replace('@', '%40').replace('/', '%2F')}@{item['version']}",
                    }
                ],
                "comment": f"Exact shipped path: Contents/Resources/app/node_modules/{item['path']}",
            }
        )
        relationships.append(
            {"spdxElementId": app, "relationshipType": "CONTAINS", "relatedSpdxElement": identifier}
        )
        relationships.append(
            {
                "spdxElementId": app,
                "relationshipType": "DEPENDS_ON",
                "relatedSpdxElement": identifier,
            }
        )
    for item in persona_rows:
        identifier = spdx_id("Persona", item["path"])
        package_rows.append(
            {
                "SPDXID": identifier,
                "name": item["name"],
                "versionInfo": "payload-record",
                "downloadLocation": "NOASSERTION",
                "filesAnalyzed": False,
                "licenseConcluded": "CC-BY-4.0",
                "licenseDeclared": "CC-BY-4.0",
                "copyrightText": "NOASSERTION",
                "comment": f"Bundled candidate persona record: {item['path']}; inclusion is not Official Catalog admission.",
            }
        )
        relationships.append(
            {"spdxElementId": app, "relationshipType": "CONTAINS", "relatedSpdxElement": identifier}
        )
    files = []
    for item in records:
        identifier = spdx_id("File", item["path"])
        files.append(
            {
                "SPDXID": identifier,
                "fileName": "./" + item["path"],
                "checksums": [
                    {"algorithm": "SHA1", "checksumValue": item["sha1"]},
                    {"algorithm": "SHA256", "checksumValue": item["sha256"]},
                ],
                "licenseConcluded": "NOASSERTION",
                "copyrightText": "NOASSERTION",
                "comment": f"mode={item['mode']:04o};bytes={item['bytes']}",
            }
        )
        relationships.append(
            {"spdxElementId": app, "relationshipType": "CONTAINS", "relatedSpdxElement": identifier}
        )
    return {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": document,
        "name": "The Green Room 0.1.0-alpha.1 final macOS arm64 payload",
        "documentNamespace": f"https://greenroomai.net/spdx/the-green-room/0.1.0-alpha.1/{ARTIFACT_SHA256}",
        "creationInfo": {
            "created": "2026-09-04T18:38:23Z",
            "creators": [
                "Tool: greenroom-release-evidence/1.0.0",
                "Organization: The Green Room project",
            ],
            "licenseListVersion": "3.27",
        },
        "documentDescribes": [artifact],
        "packages": package_rows,
        "files": files,
        "relationships": relationships,
        "annotations": [
            {
                "annotationDate": "2026-09-04T18:38:23Z",
                "annotationType": "OTHER",
                "annotator": "Tool: greenroom-release-evidence/1.0.0",
                "comment": f"THIRD-PARTY-NOTICES.txt SHA-256 {notices_hash}. All {EXPECTED_FILES} final regular files, {EXPECTED_NPM_PACKAGES} npm package paths, and {EXPECTED_PERSONAS} persona records are represented.",
            }
        ],
    }


def sanitized_notary(source: pathlib.Path) -> dict[str, Any]:
    details = source.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
        fail("notary_evidence_type_invalid")
    raw = source.read_bytes()
    if sha256_bytes(raw) != NOTARY_EVIDENCE_HASH:
        fail("notary_evidence_hash_invalid")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        fail("notary_evidence_invalid")
    required = {
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
    if value != required:
        fail("notary_evidence_invalid")
    return value


def rename_no_replace(source_name: str, destination_name: str, parent_fd: int) -> None:
    if (
        "/" in source_name
        or "/" in destination_name
        or source_name in {"", ".", ".."}
        or destination_name in {"", ".", ".."}
    ):
        fail("publication_name_invalid")
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        result = libc.renameatx_np(
            parent_fd, os.fsencode(source_name), parent_fd, os.fsencode(destination_name), 4
        )
    elif sys.platform.startswith("linux"):
        result = libc.renameat2(
            parent_fd, os.fsencode(source_name), parent_fd, os.fsencode(destination_name), 1
        )
    else:
        fail("atomic_no_replace_unsupported")
    if result != 0:
        error = ctypes.get_errno()
        fail(
            "output_exists" if error in {17, 39, 66} else "atomic_publication_failed",
            str(error),
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", required=True, type=pathlib.Path)
    parser.add_argument("--notarization-evidence", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument(
        "--repository", default=pathlib.Path(__file__).resolve().parents[2], type=pathlib.Path
    )
    parser.add_argument("--evidence-commit")
    args = parser.parse_args()
    for path in (args.artifact, args.notarization_evidence, args.repository, args.output.parent):
        if (
            not path.is_absolute()
            or pathlib.Path(os.path.abspath(path)) != path
            or (path.exists() and pathlib.Path(os.path.realpath(path)) != path)
        ):
            fail("path_noncanonical", str(path))
    if args.output.exists() or args.output.is_symlink():
        fail("output_exists")
    if args.output.parent == args.repository or args.repository in args.output.parents:
        fail("output_inside_repository")
    if args.evidence_commit is not None and not COMMIT.fullmatch(args.evidence_commit):
        fail("evidence_commit_invalid")
    source_materials = verify_source_materials(args.repository)
    records, manifest_bytes = inspect_archive(args.artifact)
    manifest = validate_manifest(manifest_bytes, records)
    with zipfile.ZipFile(args.artifact) as archive:
        package_rows = npm_packages(archive)
        persona_rows = personas(records)
        validator = [
            item for item in records if item["path"].startswith("Contents/Resources/validator/")
        ]
        if len(validator) != EXPECTED_VALIDATOR_FILES or {
            item["path"].removeprefix("Contents/Resources/validator/") for item in validator
        } != {
            "greenroom-persona",
            "_internal/base_library.zip",
            "_internal/libpython3.13.dylib",
            "_internal/yaml/_yaml.cpython-313-darwin.so",
        }:
            fail("validator_inventory_invalid")
        executable = archive_data(archive, "Contents/Resources/validator/greenroom-persona")
        if b"PyInstaller" not in executable:
            fail("pyinstaller_payload_evidence_missing")
        notices = make_notices(args.repository, archive, package_rows, persona_rows)
    notary = sanitized_notary(args.notarization_evidence)
    parent_fd = os.open(
        args.output.parent,
        os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        stage = pathlib.Path(
            tempfile.mkdtemp(prefix=".greenroom-evidence-", dir=args.output.parent)
        )
        stage_fd = os.open(
            stage.name,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
    except Exception:
        os.close(parent_fd)
        raise
    stage_identity = os.fstat(stage_fd)
    published = False
    try:
        artifact_output = stage / ARTIFACT_NAME
        with args.artifact.open("rb") as source, artifact_output.open("xb") as target:
            shutil.copyfileobj(source, target, 1024 * 1024)
        (stage / "THIRD-PARTY-NOTICES.txt").write_bytes(notices)
        spdx = make_spdx(records, package_rows, persona_rows, sha256_bytes(notices))
        (stage / SPDX_NAME).write_bytes(canonical_json(spdx))
        (stage / "notarization-evidence.json").write_bytes(canonical_json(notary))
        implementation = {
            "baseCommit": SIGNING_MERGE,
            "commit": args.evidence_commit,
            "state": "committed" if args.evidence_commit else "uncommitted-working-tree",
        }
        evidence = {
            "schemaVersion": 1,
            "artifact": {"name": ARTIFACT_NAME, "bytes": ARTIFACT_BYTES, "sha256": ARTIFACT_SHA256},
            "app": {
                "root": APP_ROOT,
                "archiveEntries": EXPECTED_ENTRIES,
                "regularFiles": EXPECTED_FILES,
                "directories": EXPECTED_DIRECTORIES,
                "treeSha256": FINAL_TREE_DIGEST,
                "manifestSchemaVersion": 2,
                "payloadFiles": EXPECTED_PAYLOAD,
                "signatureOwnedFiles": SIGNATURE_OWNED,
            },
            "components": {
                "npmPackagePaths": EXPECTED_NPM_PACKAGES,
                "personaRecords": EXPECTED_PERSONAS,
                "validatorFiles": EXPECTED_VALIDATOR_FILES,
                "nodeVersion": "24.20.0",
                "pythonVersion": "3.13.13",
                "validatorVersion": "0.1.0",
                "pyyamlVersion": "6.0.3",
                "pyinstallerVersion": "6.16.0",
            },
            "source": {
                "repository": "https://github.com/Jdelg718/the-green-room",
                "productCommit": SOURCE_COMMIT,
                "productTree": SOURCE_TREE,
                "protectedRef": "refs/heads/main",
                "signingImplementationHead": SIGNING_HEAD,
                "signingSquashMerge": SIGNING_MERGE,
                "evidenceImplementation": implementation,
                "materials": source_materials,
            },
            "toolchain": {
                "target": "arm64-apple-darwin",
                "xcodeBuild": "17F113",
                "swift": "Apple Swift version 6.3.3",
                "clang": "Apple clang version 21.0.0 (clang-2100.1.1.101)",
                "node": "24.20.0",
                "python": "3.13.13",
                "npm": "11.19.0",
                "pyinstaller": "6.16.0",
            },
            "signing": {
                "identity": SIGNING_IDENTITY,
                "teamId": TEAM_ID,
                "hardenedRuntime": True,
                "secureTimestamp": True,
                "requirements": manifest["signingPolicy"]["requirements"],
                "unsignedPayloadDigest": UNSIGNED_DIGEST,
                "preStapleTreeDigest": PRE_STAPLE_DIGEST,
                "finalTreeDigest": FINAL_TREE_DIGEST,
            },
            "notarization": {
                "submissionId": NOTARY_ID,
                "status": "Accepted",
                "acceptedStatusEvidenceSha256": STATUS_HASH,
                "acceptedPrivateLogSha256": PRIVATE_LOG_HASH,
                "privateLogIncluded": False,
            },
            "documents": {
                SPDX_NAME: sha256_file(stage / SPDX_NAME),
                "THIRD-PARTY-NOTICES.txt": sha256_bytes(notices),
                "notarization-evidence.json": sha256_file(stage / "notarization-evidence.json"),
            },
        }
        evidence_bytes = canonical_json(evidence)
        (stage / "release-evidence.json").write_bytes(evidence_bytes)
        subjects = [
            {"name": name, "digest": {"sha256": sha256_file(stage / name)}}
            for name in CHECKSUM_NAMES[:-1]
        ]
        provenance = {
            "_type": "https://in-toto.io/Statement/v1",
            "subject": subjects,
            "predicateType": "https://greenroomai.net/attestations/release-evidence-assembly/v1",
            "predicate": {
                "builder": {"id": "local:Mothership"},
                "buildType": "https://greenroomai.net/buildtypes/release-evidence-assembly/v1",
                "invocation": {
                    "environment": "local protected release workstation",
                    "parameters": {"publication": False, "attestationExecuted": False},
                },
                "materials": source_materials
                + [{"uri": f"file:{ARTIFACT_NAME}", "digest": {"sha256": ARTIFACT_SHA256}}],
                "metadata": {
                    "artifactBuildEpoch": 1788547103,
                    "evidenceAssemblyDeterministic": True,
                },
                "evidenceImplementation": implementation,
            },
        }
        (stage / "provenance.intoto.jsonl").write_bytes(canonical_json(provenance))
        sums = "".join(f"{sha256_file(stage / name)}  {name}\n" for name in CHECKSUM_NAMES).encode()
        (stage / "SHA256SUMS").write_bytes(sums)
        for path in stage.iterdir():
            path.chmod(0o444)
        visible_stage = os.stat(stage.name, dir_fd=parent_fd, follow_symlinks=False)
        if (visible_stage.st_dev, visible_stage.st_ino) != (
            stage_identity.st_dev,
            stage_identity.st_ino,
        ):
            fail("publication_stage_rebound")
        rename_no_replace(stage.name, args.output.name, parent_fd)
        visible_output = os.stat(args.output.name, dir_fd=parent_fd, follow_symlinks=False)
        if (visible_output.st_dev, visible_output.st_ino) != (
            stage_identity.st_dev,
            stage_identity.st_ino,
        ):
            fail("publication_destination_rebound")
        published = True
        print(
            json.dumps(
                {
                    "code": "release_evidence_generated",
                    "output": str(args.output),
                    "files": 7,
                    "artifactSha256": ARTIFACT_SHA256,
                },
                sort_keys=True,
            )
        )
    finally:
        try:
            if not published and stage.exists():
                current = stage.lstat()
                if (current.st_dev, current.st_ino) == (
                    stage_identity.st_dev,
                    stage_identity.st_ino,
                ):
                    for path in stage.iterdir():
                        path.chmod(0o600)
                    stage.rmdir() if not any(stage.iterdir()) else shutil.rmtree(stage)
        finally:
            os.close(stage_fd)
            os.close(parent_fd)


if __name__ == "__main__":
    try:
        main()
    except (EvidenceError, OSError) as error:
        print(
            json.dumps({"code": "release_evidence_failed", "message": str(error)}, sort_keys=True),
            file=__import__("sys").stderr,
        )
        raise SystemExit(1)
