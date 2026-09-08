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

## B3 Windows stretch — desk-checked, no Windows machine

Read-only findings from the source at `b860c96`, not a Windows run. They tell Amy what B3 would hit on day one and what the minimal change is.

- **No launcher works on Windows today.** `start:linux` refuses any platform but Linux. `start:local` forces `GREENROOM_PERSONA_INSPECTION=required` and needs `.venv/Scripts/greenroom-persona.exe`; the README states enabled Windows inspection intentionally fails until the ACL and Job Object gates exist. The only route is plain `npm start` with `GREENROOM_CREDENTIAL_STORE=file` set by hand, which `src/config.ts` permits on any non-darwin platform in source mode.
- **`FileCredentialStore` fails closed at construction on NTFS.** It creates `credentials/` with mode `0o700`, then asserts `(mode & 0o777) === 0o700` on the directory and `=== 0o600` on each file after an explicit chmod. Windows ignores the create mode and maps chmod to the read-only attribute only, so Node reports `0o777` for directories and `0o666` or `0o444` for files. The assertion throws `credential_store_unsafe` before the server can serve a request, so the store is unusable there rather than merely weaker.
- **Minimal B3 change, if a Windows box appears:** a `process.platform === "win32"` branch that skips the POSIX mode assertions, keeps the `O_EXCL | O_NOFOLLOW` create, symlink, canonical-path, and single-link checks, and changes the startup notice to say permissions are best-effort on NTFS; plus a launcher path that does not force inspection. Do not weaken the POSIX checks for other platforms. Nothing here is verified until run on Windows.

### Running B3 in the Omarchy Windows VM

Kent's machine has Omarchy's built-in Windows VM helper (`omarchy-windows-vm`, a `dockurr/windows` Windows 11 guest under KVM) but it is **not installed yet**: no runtime directory exists, the Docker service is disabled, and installation needs an interactive polkit/sudo password, package installs (freerdp, netcat, gum), a RAM/disk/username prompt, and a Windows 11 download and unattended install of roughly 6 GB and 20 to 40 minutes. That step is Kent's, at the desktop:

```bash
omarchy-windows-vm install     # host has 7 GB RAM and 6 cores: choose 4G RAM, 32G disk
omarchy-windows-vm launch      # RDP window; http://127.0.0.1:8006 shows the console during install
```

The host folder `~/Windows` appears inside the guest as `\\host.lan\Data`; use it to move logs out, never credentials.

Inside the guest, in order, recording the exact message at each step:

1. Install Git for Windows, Node 24.20.0 x64 from nodejs.org, then `npm install -g npm@11.19.0` (the bundled npm is older; the launcher and clean-source policy require exactly 11.19.0). Install Python 3 and Visual Studio 2022 Build Tools with the "Desktop development with C++" workload; `fs-ext@2.1.1` has no prebuilt binary and must compile through node-gyp.
2. `git clone https://github.com/Jdelg718/the-green-room.git C:\gr\the-green-room` (short path), `cd` in, confirm `node --version` is v24.20.0 and `npm --version` is 11.19.0.
3. `npm ci --strict-allow-scripts=true --foreground-scripts`. Record whether the `fs-ext` node-gyp build succeeds under MSVC. If it fails, B3 stops here and that is the report.
4. `npm run build`.
5. Launcher attempts, each expected to fail closed today:
   - `npm run start:linux` should print `start:linux requires Linux; received win32`.
   - `npm run start:local` should print `Local source runtime is not prepared` because `.venv\Scripts\greenroom-persona.exe` is absent; do not install `uv` in the guest for B3.
6. Baseline without the credential store, to prove the server runs on Windows at all: set `GREENROOM_DATA_DIR=C:\gr\data` and run `npm start`. Expect the writer lock, SQLite, and `http://127.0.0.1:8787` to come up and `/api/bootstrap` to report `providerSetup.cloud: false`. Record any `fs-ext` lock or path error.
7. The B3 path: additionally set `GREENROOM_CREDENTIAL_STORE=file` and `GREENROOM_PERSONA_INSPECTION=optional`, run `npm start` again. Prediction from the source: startup throws `credential_store_unsafe` from the `0o700` directory-mode assertion. Record whether the process exits or keeps serving, and the exact error text.
8. If step 7 fails as predicted, the finding is the report; do not patch in the guest. If it unexpectedly starts, set up OpenRouter through the UI with a real key entered only in the browser, send one line, stop, relaunch, and confirm the room and connection persist; then check `icacls C:\gr\data\credentials` and note that NTFS ACLs, not POSIX modes, are what protects the file.
9. Report on #177 under B3 in five lines: what ran, exact commands, what broke and where, what was skipped, next step. Stop the VM with `omarchy-windows-vm stop`.

## Do not touch tomorrow

- PR #55 (arts and music historical packs). Roadmap item 5 defers it until the TestFlight gate is stable.
- macOS packaging issues #140 and #145, memory and catalog work, the demo video.
- B3 Windows stretch, unless a Windows machine appears.
- No TestFlight upload, external invitation, website link, or announcement. No App Store submission.
- No `npm run check` or `npm run acceptance` under Node 26; no widening of the install-script allowlist; no merging on Kent's behalf.

## End-of-day acceptance

- Lane 1 has a one-sentence signing verdict: archive-ready, or one exact blocker.
- A TestFlight readiness issue exists under #160 with the checklist above, owners, and the stated sequence.
- #177 carries Kent's Omarchy slice report and the Linux box is ticked, or exactly one blocker issue exists with a reproducible symptom.
- The docs truth-up draft PR has a green `release-gate`, Kent's review, and the roadmap checkpoint line added after Lane 3.
- No credential, key-prefix match, device identifier, or private path appears in git, logs, issue comments, or screenshots. The iPhone screenshot stays in the session cache.
