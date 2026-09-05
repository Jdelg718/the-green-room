# ADR 0005: macOS Developer ID signed-payload trust and notarization

- **Status:** Accepted for the bounded macOS arm64 candidate pipeline
- **Date:** 2026-09-04
- **Decision owners:** Green Room maintainer and release owner
- **Implements:** GitHub issue #142 and the architecture decision recorded in issue comment `5542907917`
- **Does not authorize:** credentials creation, tags, uploads, releases, website changes, deployment, or publication

## Decision

Keep the deterministic unsigned `.app` and manifest-v1 inventory as immutable build evidence. Developer ID signing always operates on a private copy. The signed copy replaces the manifest with schema version 2, whose `unsignedPayloadDigest` binds it back to the verified v1 app, whose exact sorted `payloadFiles` records contain `path`, POSIX `mode`, byte length, and SHA-256. Its closed `signatureOwnedFiles` list contains exactly `Contents/MacOS/GreenRoomLauncher` (the outer signature is embedded in the main executable), `Contents/_CodeSignature/CodeResources` (the outer resource seal), and `Contents/CodeResources` (the later stapled ticket). This avoids an impossible manifest/main-executable signature cycle while exact requirement verification still seals the launcher. Before notarization the ticket is the sole permitted absent owned file; final verification requires all three. The manifest does not digest itself; the final outer application signature seals it.

The locked release identity is `Developer ID Application: James DelGuercio (JZ233HBW3Z)`. Before copying or changing payload bytes, the signer requires `security find-identity` to contain exactly one valid code-signing identity and requires it to be that exact identity and Team ID. Every Mach-O is discovered by file magic rather than filename. Only the four stable code roles and Mach-O members of the frozen validator or production native npm tree are classifiable. An executable non-Mach-O, an unknown Mach-O, a link, special file, hardlink, junk metadata, or undeclared payload file fails closed.

Nested code is signed explicitly from the deepest object outward with `codesign --force --sign <exact identity> --options runtime --timestamp`, a stable identifier, and an exact designated requirement. The outer app is signed last. `--deep` is never used for signing; it is only a final verification backstop. Every nested object and the outer app are independently verified with `codesign --verify --strict -R=<exact requirement>`, and signature details must show Team `JZ233HBW3Z`, hardened runtime, and a secure timestamp. The credential helper's v2 manifest record contains its post-signing digest, and production runtime trust derives the one exact designated requirement from v2. Supplying or falling back to ad-hoc trust for v2 is an error. The existing v1 ad-hoc path remains solely for the separately identified unsigned artifact and its tests.

The bounded distribution container for this issue is a ZIP, resolving the earlier ZIP-versus-DMG question in favor of the smaller auditable surface. Notarization accepts only a pre-existing Keychain profile name. Raw Apple IDs, passwords, team arguments, API keys, issuers, and matching environment variables are rejected. The app is submitted in a disposable `ditto` ZIP; only an exact structured `Accepted` result permits stapling. Evidence retains only the canonical submission ID and status. Failure or malformed output does not staple or publish a final ZIP, and disposable material is always removed.

After acceptance, the pipeline staples and validates the app, reruns explicit nested and outer signature checks, Gatekeeper assessment, and staple validation, then creates the final deterministic ZIP. Its members are sorted with fixed timestamps and preserved `0444`/`0555` modes. Creation and clean extraction reject traversal, duplicate paths, links, hardlinks, special files, extended attributes, and platform junk. The extracted app must pass the same complete verification before the ZIP is moved to its requested final name.

## Operational boundary

Use `npm run package:macos:unsigned -- …` to create the canonical unsigned evidence artifact, `npm run package:macos:signed -- --unsigned-app … --output-parent … --identity "Developer ID Application: James DelGuercio (JZ233HBW3Z)"` to create the private signed copy, `npm run notarize:macos -- --app … --output-zip … --keychain-profile …` only when an owner-created profile already exists, and `npm run verify:macos:signed -- …` for the stapled app or final ZIP.

No command in this pipeline creates or stores a notary profile. If a profile is absent, stop after local Developer ID verification. Issue #143 owns final SBOM, checksums, and attestations; issues #144 and #145 own clean-standard-user evidence and independent publication review.

## Consequences

- Signed bytes are intentionally not reproducible because Developer ID and notarization timestamps are external authorities; signed semantics and exact final digests are the evidence.
- The v1 artifact remains comparable across deterministic builds and is never polluted by signing resources.
- Any future new executable, native dependency, signature-owned path, entitlement, Team ID, identifier, requirement, container type, or stapler behavior requires a reviewed schema/policy change rather than a wildcard exclusion.
