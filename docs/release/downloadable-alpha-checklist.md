# Downloadable Alpha release-evidence checklist

Issue #143 assembles evidence for one immutable input only. It does not authorize an attestation run, tag, release, upload, deployment, DNS change, website change, or public announcement.

## Locked candidate

- Artifact: `The-Green-Room-0.1.0-alpha.1-macos-arm64.zip`
- Bytes: `51598158`
- SHA-256: `333f5cdd2e9c88e901cacd5cdad58109b67affc1f63cc5f98321644592bde469`
- Product source: `cd0096c53e356a4c2a7830ecbed5db690485c070`
- Signing implementation head: `ed92f1f9efb9635dde3579ef09fe62c5311cb6a9`
- Signing squash merge: `6171a2736886f899e5221cc734444934e5cfa0fb`
- Unsigned payload digest: `673726aa78d8ecd647f7296ef6c08bd94ac6a0f13a001c2eee1140176e351d8c`
- Pre-staple tree digest: `60b0845fe300ede1695f68515e721094d09e3bed08fb102e6c5be304807e8629`
- Final extracted tree digest: `c05036f9828ba344188e085cfbc0090b249e05046039c64fa8e409a55abbd674`
- Notary submission: `1b9c51ee-280b-4349-9459-583e967651e8`, exact status `Accepted`

The public evidence retains only the accepted status digest and private-log digest. Never copy the raw private notary log, its path, a Keychain profile, credentials, or secrets into this repository or an evidence directory.

## Assemble without clobbering

Use absolute canonical paths. The output directory must not exist, must be outside the source tree, and is atomically renamed from a private staging directory only after every document is complete.

```bash
npm run package:release-evidence -- \
  --artifact /absolute/path/to/The-Green-Room-0.1.0-alpha.1-macos-arm64.zip \
  --notarization-evidence /absolute/path/to/notarization-evidence.json \
  --output /absolute/external/path/greenroom-issue-143-evidence \
  --repository "$PWD"
```

Before the evidence implementation is committed, the manifest truthfully records `uncommitted-working-tree` and a null evidence commit. After merge, regenerate from protected `main` with `--evidence-commit "$(git rev-parse HEAD)"`; this finalization layer avoids making an evidence document claim its own pre-existing commit.

The directory contains exactly the immutable ZIP, SPDX 2.3 JSON, `THIRD-PARTY-NOTICES.txt`, sanitized `notarization-evidence.json`, `release-evidence.json`, custom in-toto Statement v1 JSONL, and `SHA256SUMS`. `SHA256SUMS` is last and contains exactly the six documented basenames in canonical order. Attestation bundles and `SHA256SUMS.sig` are forbidden.

## Independent verification

Copy the seven files into a fresh directory without links and run only the dependency-free verifier from a trusted checkout:

```bash
npm run verify:release-evidence -- /absolute/fresh/evidence-directory
```

The verifier rejects omissions, duplicates, extra outputs, substituted paths, archive traversal, duplicate members, links, hardlinks, special types, junk, xattrs encoded as ZIP extras, bombs, noncanonical modes, byte tampering, manifest rebound, stale pre-staple identity, incorrect source/locks/toolchain/signing/notary facts, all-57-uv-package overclaims, missing licenses, incomplete SPDX files/components/relationships, a wrong namespace, malformed checksum allowlists, private fields, and provenance subjects for different bytes.

Measured payload coverage is 1,651 ZIP entries: 310 explicit directories and 1,341 final regular files. Manifest v2 owns 1,337 payload records plus three signature-owned files and the manifest. The SBOM covers all 1,341 final files, all 52 actual production npm package paths including duplicate versions, Node 24.20.0, CPython 3.13.13, validator 0.1.0, PyYAML 6.0.3, the four-file frozen validator, the native launcher/helper, and 19 bundled persona records. PyInstaller 6.16.0 is represented only as the proven validator build tool; the payload executable contains PyInstaller bootloader evidence and the exact source lock/build tool records pin 6.16.0. Locked upstream CPython, PyYAML, and PyInstaller/bootloader license texts are incorporated into the deterministic notices and hash-checked before assembly. The SBOM does not claim all 57 `uv.lock` packages ship.

## Protected attestation gate

`.github/workflows/release-evidence-attest.yml` is manual, protected by the `macos-release` environment, restricted to protected `main` in this repository, and uses only `contents: read`, `id-token: write`, and `attestations: write`. It requires an exact reviewed `expected_sha`, pins `actions/attest@v4` to a full commit, and refuses evidence whose committed implementation layer is not that dispatched SHA. It creates a custom release-evidence-assembly attestation and an SPDX SBOM attestation, both for the exact ZIP subject. The two generated Sigstore bundles are emitted as one immutable, 30-day workflow artifact for reviewer download; this is evidence transport, not a GitHub Release asset or public-download publication.

Do not dispatch it during implementation or review. An approved environment reviewer must separately confirm the exact candidate, verifier output, source SHA, subject bytes, and repository/ref before allowing attestations. Publication remains a later explicit owner decision.
