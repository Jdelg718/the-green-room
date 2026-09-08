# Green Room execution plan — 2026-09-08

**Owner:** Amy (Mothership, macOS). **Kent's part:** the Omarchy human run in Lane 3. **Baseline:** protected `main` at `b860c96` (docs: advance roadmap to TestFlight alpha, #187). Follows the [ROADMAP current execution order](../../ROADMAP.md#current-execution-order), sprint issue #177, and the 2026-09-07 iPhone Alpha and TestFlight handoff. This plan authorizes no release, publication, App Store submission, or website link.

## Verified on Omarchy the evening before (2026-09-07, `dell-omarchy`)

These checks passed at `b860c96` on Kent's Omarchy desktop. Nobody needs to repeat them; only the human run in Lane 3 remains.

| Check | Result |
| --- | --- |
| `npm ci --strict-allow-scripts=true --foreground-scripts` under Node 24.20.0 / npm 11.19.0 | exit 0, 182 packages, only `fs-ext@2.1.1` ran `node-gyp`, `gyp info ok` |
| `npm run build` under Node 24.20.0 | exit 0 |
| `node --test dist/test/e2e/linux-source-launch.test.js` | 2 passed, 0 failed |
| `npm run start:linux` with a disposable `GREENROOM_DATA_DIR` | printed `Green Room: http://127.0.0.1:8787`; `/health` 200; `/api/bootstrap` reported `providerSetup.cloud: true`; `credentials/` created `0700`; SIGTERM shut down cleanly and freed the port |
| `npm run start:linux` under the machine default Node 26.8.1 | refused: `start:linux requires Node 24.20.0; received 26.8.1.` |

## Correction to the handoff's Linux commands

The handoff's five Linux commands are right, but Kent's Omarchy machine defaults to **Node 26.8.1** through mise. The launcher hard-fails on anything but 24.20.0, and `npm ci` under Node 26 would compile `fs-ext` against the wrong ABI before the launcher ever complains.

**Resolved the same night:** the checkout now carries `mise.toml` pinning `node = "24.20.0"`. In an interactive shell on Kent's machine, `cd ~/Projects/the-green-room && node --version` prints `v24.20.0`, so the handoff commands work verbatim there. A non-interactive login shell (`bash -lc`) still reports 26.8.1 because mise activation is interactive-only on this machine; scripts and cron-style invocations should keep the explicit prefix below.

```bash
cd ~/Projects/the-green-room
git pull --ff-only origin main
mise exec node@24.20.0 -- node --version      # must print v24.20.0
mise exec node@24.20.0 -- npm ci --strict-allow-scripts=true --foreground-scripts
mise exec node@24.20.0 -- npm run build
mise exec node@24.20.0 -- npm run start:linux
```

`mise shell node@24.20.0` once per terminal session is equivalent. `start:linux` refuses macOS by design; Amy's own Mac path remains `start:local` and is not needed tomorrow.

## Lane 1 — Amy: verify App Store Connect access and distribution signing

**Why:** handoff critical-path step 1. The Mothership Keychain shows Apple Development identities but no Apple Distribution identity. Everything after this depends on whether Xcode automatic signing can provision one.

1. Confirm App Store Connect access for team `JZ233HBW3Z`, the bundle-ID record `net.greenroomai.GreenRoom`, current agreements, and roles sufficient to create an app record and upload builds.
2. In Xcode, verify that automatic signing can provision an Apple Distribution certificate and an App Store provisioning profile for the App target. Verify; do not assume. No credentials in chat, screenshots, or issue text.
3. Record the outcome in one sentence: archive-ready, or exactly one blocker with the exact Xcode or App Store Connect message.

**Hard stop:** creating an App Store Connect app record is fine; uploading, submitting, or inviting anyone is not authorized tomorrow.

## Lane 2 — Amy: open the TestFlight readiness issue under #160

**Why:** handoff critical-path step 2 and roadmap execution item 2. One tracking issue, referencing #160 without closing it, linking Phase 7 and Phase 8 of `docs/plans/2026-09-05-standalone-iphone-alpha.md` rather than duplicating them. Each line gets a named owner. Concrete repo findings to put in the checklist:

- **Recommended model.** The iPhone provider sheet's model field (`ios-web/index.html`, `provider-model`) is free text with no default or placeholder. The handoff recorded `openai/gpt-oss-20b` prefixing a Franklin reply with Georgian characters. Set `openai/gpt-4.1-mini` as the recommended default; it is already the model used in the provider-bridge and transport fixtures. Do not silently filter non-English output.
- **User-visible failure states.** `ios-web/room-runtime.js` collapses every failure into two strings, "Provider setup failed." and "Reply failed." Split into no-provider, offline, provider non-2xx, timeout, and canceled-credential cases with a next action on each.
- **Export compliance.** `ios/App/App/Info.plist` has no `ITSAppUsesNonExemptEncryption` key. The app uses only standard HTTPS. Decide the answer once, add the key, and keep the reasoning in the issue, so each upload does not stall on the compliance prompt.
- **Privacy policy URL.** `greenroomai.net` has no privacy page. App Store Connect requires one for external TestFlight. Draft it in a `site/` PR describing what the app stores locally, what goes to the user's selected provider, and what the project never receives. Merging deploys it, so Kent approves the merge.
- **Version and build identity.** `project.pbxproj` carries `MARKETING_VERSION = 1.0` and `CURRENT_PROJECT_VERSION = 1`. Decide the alpha scheme before the first archive so the read-back identity is meaningful.
- **Privacy manifest.** `ios/App/App/PrivacyInfo.xcprivacy` exists with the four standard keys. Verify its declared API reasons against actual use; proportional, not a full audit.
- **Proportional external-alpha matrix** from the handoff: 320/375/390 containment, portrait fallback, keyboard and composer, basic VoiceOver and Dynamic Type, offline existing-room behavior, clean install, update/reinstall retention, real reply, direct target, force-quit and relaunch.
- **Sequence stated in the body.** Internal TestFlight install first, read back the exact build identity, repeat the physical acceptance, then external Beta App Review with a small tester group. Public link, website placement, and any announcement are separate gates needing Kent's approval. Builds expire after 90 days. This is not a direct `.ipa` download and not an App Store release.

Handoff estimate to carry into the issue: internal TestFlight in two to three focused days if signing works; external link five to ten calendar days; best case 2026-09-11, responsible target 2026-09-14 through 2026-09-18.

## Lane 3 — Kent: Omarchy human run with a real cloud key (Amy records)

**Why:** roadmap execution item 1, the handoff's "still required" Linux item, and the last unchecked Linux line in #177. Kent runs it on his Omarchy desktop; Amy records the result and closes the sprint item.

1. Launch with the corrected commands above. Default data root is `<repo>/.local/first-playable` (gitignored). For disposable evidence, prefix the start command with an absolute `GREENROOM_DATA_DIR=$HOME/greenroom-omarchy-data`.
2. Open `http://127.0.0.1:8787`. Choose OpenRouter, paste the key only into the UI field, acknowledge the cloud disclosure, enter `openai/gpt-4.1-mini` (no `openrouter/auto`, no fallback variants), press Test. Expect `ready`.
3. Bind the model profile to the room, seat one to three characters, send a line, receive an in-character reply. One small paid call.
4. Permissions, from a second terminal. Expect `drwx------` on the directory and `-rw-------` on `credential:openrouter-main:1`.
   ```bash
   ls -la "$HOME/greenroom-omarchy-data/credentials"
   ```
5. Leak check. Grep the prefix only, never the full key. Every count must be 0. Eyeball the launcher's terminal output for the same prefix.
   ```bash
   grep -a -c 'sk-or-v1-' "$HOME/greenroom-omarchy-data"/greenroom.sqlite*
   ```
6. Restart continuity. `Ctrl-C`, confirm exit and that `ss -ltn | grep 8787` is empty, relaunch on the same data root. Room, reply, and connection (status `stored`) must survive. Send a second line to prove the stored key still works.
7. Report on #177 in the sprint's five-line shape: what works, exact command, what was skipped, what is next. Tick the Omarchy "Done when" box. Either waive B3 (no Windows machine) and close the sprint, or leave #177 open with B3 as the only remaining line.

**Hard stop:** key prefix in SQLite, logs, or shell history; `providerSetup.cloud` false; room or connection gone after relaunch; launcher building under the wrong Node. File one focused issue with the exact symptom; do not patch around it inside a docs PR.

## Lane 4 — Amy: review the documentation truth-up PR, then add the roadmap line

Most of this lane was done the night before and sits in a draft PR against #177 (branch `docs/issue-177-linux-node-pin`). Kent reviews it like any sprint slice.

Done in the draft PR:

- `mise.toml` pinning Node 24.20.0 (the Node-selection decision).
- `README.md` status paragraph rewritten: it claimed environment-based provider setup, LM Studio as the only real provider, and one room; all three were contradicted by the roadmap's R1 and R3 current truth. The Linux section now carries a `node --version` guard and the mise note.
- `docs/runbooks/source-operator-alpha.md` Linux snippet carries the same Node guard.
- This plan.

Still open in this lane:

- `ROADMAP.md` checkpoint line: replace "an Omarchy human run remains outstanding" with the verified statement, date, and SHA from Lane 3. Add it to the same PR after Kent's run, or as a one-line follow-up.
- The Omarchy quickstart runbook still shows per-command `mise exec node@24.20.0 --`. That remains correct and is dated evidence; leave it unless Amy prefers one form everywhere.
- Full `npm run check` on the Omarchy machine is green after installing `uv` (0.12.10 via `mise use -g uv@latest`) and running `uv sync --locked --no-dev`: 581 tests, 556 passed, 0 failed, 25 skipped (all macOS-only), plus the mobile containment render 1/1. With the dev sync, `npm run check:python` also passed (251 passed, 12 skipped, Ruff and mypy clean) and `npm run acceptance` passed with restart continuity and zero external requests, so `check:release` is green on this machine. An earlier run without `uv` failed 7 validator tests with `validator executable is unavailable`; that is the expected symptom on a machine without the Python validator, not a code defect.
- Leave `docs/release/` untouched. Nothing may claim a release.

## B3 Windows stretch — executed on the FF2K tower (2026-09-07, late)

Run over Tailscale SSH on Kent's FF2K tower: Windows 11 Pro 10.0.26200, 24 cores, 126 GB RAM, Visual Studio Build Tools 2022 (MSVC 14.44, SDK 10.0.26100), Git 2.52.0.windows.1 with system `core.autocrlf=true`. A portable Node 24.20.0 (SHA-256 verified against `SHASUMS256.txt`) with its bundled npm 11.19.0 was staged under `C:\gr` so the system Node 24.11.1 was untouched. Repository at `b860c96`. No provider key was entered at any point; logs are at `C:\gr\logs` on the tower and a copy is in the session scratchpad. The Omarchy Windows VM was not installed and is not needed.

**What works on Windows**

| Step | Result |
| --- | --- |
| `npm ci --strict-allow-scripts=true --foreground-scripts` | exit 0 in 17 s; `fs-ext@2.1.1` compiled through node-gyp and MSVC with `gyp info ok`; `install-scripts ls` returned `{"allowScripts":[]}`; `package.json`, `package-lock.json`, `.npmrc` unchanged |
| `npm run build` | exit 0 |
| `node dist\src\server.js` with `GREENROOM_DATA_DIR=C:\gr\data` and `GREENROOM_PERSONA_INSPECTION=disabled`, LF bytes | listens on `127.0.0.1:8787`; `/health` 200; `/api/bootstrap` reports `providerSetup.cloud: false`; `node:sqlite`, migrations, and the `fs-ext` writer lock all work on NTFS |
| Second start on the same data root after a hard kill | listens again; the writer lock released; port free after stop |

**What breaks, in the order a Windows user hits it**

1. **Default clone produces CRLF and the runtime refuses to start.** With `autocrlf=true`, every `npm start` died with `Invalid bundled historical personas: runtime file AGENTS.md has invalid UTF-8 text encoding`; the strict decoder rejects any `0x0D` byte by design. Resetting the working tree to LF bytes fixed it with the same build. Fix: PR #189 adds `.gitattributes` with `* -text`; a fresh `autocrlf=true` clone of that branch on the tower has 0 of 18 persona `AGENTS.md` files with CR, while the same clone of `main` has CR.
2. **No launcher works, and the source default inspection mode fails on win32.** `start:linux` prints `start:linux requires Linux; received win32`. `start:local` prints `Local source runtime is not prepared` without the validator. The source default `GREENROOM_PERSONA_INSPECTION=optional`, which `start:linux` also sets, throws `enabled inspection on Windows awaits reviewed ACL and Job Object support`; only `disabled` boots. The B3 note "try start:local with inspection optional" is therefore wrong for Windows.
3. **The file credential store fails closed, and correctly so.** With `GREENROOM_CREDENTIAL_STORE=file`, startup throws `credential_store_unsafe` from the `0o700` directory-mode assertion, as predicted. `icacls` on the created `credentials` directory shows the inherited NTFS ACL: `BUILTIN\Users (RX)` and `Authenticated Users (M)`. Skipping the POSIX check would leave a key readable by other local users, so a Windows implementation needs an explicit private ACL (`icacls /inheritance:r /grant:r <user>:F` or the equivalent API), which is the ACL gate the README already names. Best-effort on NTFS is not an acceptable B3 shortcut.
4. **`npm run check` on Windows, LF checkout, no validator:** 582 tests, 391 passed, 163 failed, 28 skipped. Failure classes from the log: canonical-path checks rooted at POSIX `/` (`path_component_missing: \C:`), `EPERM: operation not permitted, fsync` on directory handles in backup, restore, and purge tests, tests that hard-code `/usr/bin/python3`, `/usr/bin/openssl`, and `/usr/bin/git`, validator-sidecar spawn failures, `GREENROOM_DATA_DIR must be an absolute normalized path` for POSIX-shaped fixture paths, and the two gates above. None of this is a Windows support claim; it is the inventory.

**Skipped:** no real provider reply on Windows (no key, and the store refuses); no ACL implementation; no Windows launcher; nothing in `docs/release/`.

**Next, Amy's call:** merge PR #189; decide whether B3 continues as a focused `FileCredentialStore` win32 branch with an explicit private ACL plus a `start:windows` that sets inspection `disabled`, or parks with this inventory. The five-line slice report is posted on #177.

## Do not touch tomorrow

- PR #55 (arts and music historical packs). Roadmap item 5 defers it until the TestFlight gate is stable.
- macOS packaging issues #140 and #145, memory and catalog work, the demo video.
- B3 follow-up implementation (Windows ACL store, `start:windows`); the B3 inventory is done and any implementation is a new slice.
- No TestFlight upload, external invitation, website link, or announcement. No App Store submission.
- No `npm run check` or `npm run acceptance` under Node 26; no widening of the install-script allowlist; no merging on Kent's behalf.

## End-of-day acceptance

- Lane 1 has a one-sentence signing verdict: archive-ready, or one exact blocker.
- A TestFlight readiness issue exists under #160 with the checklist above, owners, and the stated sequence.
- #177 carries Kent's Omarchy slice report and the Linux box is ticked, or exactly one blocker issue exists with a reproducible symptom.
- The docs truth-up draft PR has a green `release-gate`, Kent's review, and the roadmap checkpoint line added after Lane 3.
- No credential, key-prefix match, device identifier, or private path appears in git, logs, issue comments, or screenshots. The iPhone screenshot stays in the session cache.
