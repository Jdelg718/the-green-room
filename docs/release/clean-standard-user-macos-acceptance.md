# Clean standard-user macOS acceptance

Issue #144 is the minimal release-critical clean-Mac gate for Alpha 1. This
repository defines the contract and verifier; it does **not** claim the run has
happened. It does not authorize a VM boot, transfer, upload, tag, release,
deployment, publication, credential use, or fabricated evidence.

## Exact candidate and target

- `The-Green-Room-0.1.0-alpha.1-macos-arm64.zip`
- 51,598,158 bytes
- SHA-256 `333f5cdd2e9c88e901cacd5cdad58109b67affc1f63cc5f98321644592bde469`
- embedded source `cd0096c53e356a4c2a7830ecbed5db690485c070`
- macOS 26.5.2, its separately frozen exact build, arm64, Standard account
- install under `~/Applications`; no administrator action

The Safari URL and redirects must be public HTTPS. `file:`, localhost, IP
literals (including IPv6), `.local`, `.test`, `.invalid`, `.example`, host
shares, and mutable landing pages fail. The final URL must contain the exact
artifact filename or digest. The exact observed URL, OS build, and #143 release
evidence digest are repeated inside signed phase reports, binding those
otherwise run-specific values to the automated evidence.

## Release-critical flow

1. **Baseline:** record exact macOS/build/architecture; prove Standard/non-admin,
   no developer tools, host Node/Python/npm/uv, source checkout, host share, or
   pre-existing Green Room process/data/listener. The operator captures the
   visible Standard-account screen.
2. **Safari acquisition:** use the real staged/public HTTPS URL in Safari. Record
   the complete redirect chain; prove exact ZIP size/SHA-256, exact #143 checksum
   and evidence digest, authentic quarantine, and matching quarantine origin.
   Capture Safari's completed download and visible final URL. No local transfer,
   share, browser automation, or Safari auto-extraction substitutes for this.
3. **Gatekeeper and launch:** extract with Finder/Archive Utility, move to
   `~/Applications`, and double-click. Use ordinary Gatekeeper **Open** only.
   Never right-click/Open, remove quarantine, change security policy, or invoke
   the bundled server directly. Prove propagated quarantine, exact signed app,
   accepted Gatekeeper result, real launcher lineage, browser origin
   `http://127.0.0.1:8787/`, and exactly one `127.0.0.1:8787` listener with zero
   wildcard/non-loopback listeners. Record any admin, Terminal, Keychain, TCC,
   firewall, or other unexpected prompt as failure.
4. **Catalog and one interaction:** prove the exact 19 bundled members (18
   historical plus FF2K) by the SHA-256 of this ordered slug list:
   `ada-lovelace`, `benjamin-franklin`, `elizabeth-i`, `frederick-douglass`,
   `galileo-galilei`, `george-washington`, `hal-finney`, `isaac-newton`,
   `jane-austen`, `john-maynard-keynes`, `len-sassaman`,
   `leonardo-da-vinci`, `ludwig-von-mises`, `mary-shelley`,
   `milton-friedman`, `nicolaus-copernicus`, `thomas-jefferson`,
   `timothy-c-may`, `ff2k`. Create one room and send one human prompt. This gate
   requires persisted interaction, not a fabricated persona response or real
   provider credential.
5. **Quit and relaunch:** Quit normally, wait without a fixed sleep, and prove
   zero Green Room processes/listeners. Relaunch through Finder, prove the same
   room and one human prompt persist, recheck localhost-only listening, and
   reverify candidate bytes/signature identity.

## Evidence split and limitations

Automation emits one canonical `clean-user-automated-phase.v1` report per phase,
with stable checks, bounded metrics, timestamps, and a detached CMS signature.
Human-only observations each reference one distinct, valid PNG screenshot by
SHA-256. The verifier rejects missing/reordered checks, failed/default values,
stale or overlapping phases, local/private acquisition, wrong target/candidate,
missing quarantine, hash drift, unsigned automated reports, reused screenshots,
links/hardlinks, extra files, and attachment replacement during verification.

A valid passing record must state both honest limitations exactly:

- `issue-141-lifecycle-qualified-in-source-not-reenacted-on-clean-mac`
- `human-screenshots-are-corroborative-not-machine-proof`

Issue #141 at `cd0096c53e356a4c2a7830ecbed5db690485c070` already owns automated
backup/restore, compatible rollback, newer-schema refusal, uninstall-retain,
reinstall, marker-owned purge, and adversarial lifecycle qualification. Those
noncritical disaster scenarios are referenced, not reenacted in this clean VM.
The minimal #144 run does not claim loopback-fixture conversation quality,
provider credentials, TCC database enumeration, or disaster-recovery execution.

## Verify exported evidence

Export only from a clone after the authoritative VM is stopped. The flat export
directory contains canonical `clean-user-acceptance.v1.json`, five canonical
signed phase reports, five CMS signatures, and the distinct sanitized PNGs. It
contains no raw events/xattrs, paths, usernames, PIDs, room text, credentials,
process arguments/environment, Keychain/TCC databases, or log tails.

On a macOS review host, from a trusted checkout:

```bash
npm run verify:clean-mac-acceptance -- /absolute/path/to/exported-evidence
```

The verifier uses `/usr/bin/security cms` to validate each detached signature,
extracts the certificate actually named by CMS `SignerInfo`, and requires its
exact Developer ID Application identity and Team ID. It uses `/usr/bin/sips` to
parse each PNG. There is no CLI bypass. A pass is fresh
for at most 24 hours and prints one bounded JSON summary.

## Runtime handoff

Before the operator starts, freeze and provide without secrets:

- the immutable HTTPS URL and allowed redirect chain;
- the exact #143 release-evidence SHA-256;
- the sealed image's exact `sw_vers -buildVersion`;
- the signed acceptance-kit hash and approved evidence-export clone procedure.

The human operator performs only the Safari/Finder/Gatekeeper/UI/Quit steps as
the Standard user. No password, API key, Apple ID, temporary-admin action, TCC
grant, share, clipboard, source checkout, or host toolchain enters the run.
Until real evidence passes the verifier, #144 remains open.
