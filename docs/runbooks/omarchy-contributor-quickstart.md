# Linux / Omarchy contributor quickstart

Verified on an existing Omarchy Linux x86_64 development machine at
`c6d25335033c209dc912d20b24ae08135eb4f194`, using Node **24.20.0** and npm
**11.19.0**. This is a focused contributor check, not Linux installer support,
clean-host acceptance, or the full release gate.

Read [AGENTS.md](../../AGENTS.md) and its “Read first” documents before editing.
Follow [Contributing](../../CONTRIBUTING.md) for issue ownership and review.
For Python validator setup, application launch, and clean-source evidence, use
the existing [source operator runbook](source-operator-alpha.md).

## Prerequisites

Run from the repository root in Bash. These checks succeeded on this machine:

```bash
git rev-parse HEAD
git status --short
git --version
uname -sm
python3 --version
make --version
c++ --version
mise exec node@24.20.0 -- node --version
mise exec node@24.20.0 -- npm --version
```

The recorded checkout was clean. Tools reported Git 2.55.0, Linux x86_64,
Python 3.14.7, GNU Make 4.4.1, GCC 16.2.1, Node v24.20.0, and npm 11.19.0.
Python, Make, and a C/C++ compiler are needed for the native `fs-ext` build;
these observed compiler/Python versions are not additional exact-version pins.

This recipe assumes mise and Node 24.20.0 are already installed. Each
`mise exec` selects Node only for that command and its children. The default
Node on this machine was 26.8.1: do not use it for installs, builds, or tests.
Stop if either selected Node/npm version differs from the required versions.
Missing toolchain installation needs separate approval; no global configuration
or system-package installation is part of this verified recipe.

## Locked dependencies

The verified install used existing npm package and Node-header caches:

```bash
mise exec node@24.20.0 -- npm ci --offline --strict-allow-scripts=true --foreground-scripts --no-audit --no-fund
mise exec node@24.20.0 -- npm install-scripts ls --json
git diff --exit-code -- package.json package-lock.json .npmrc
```

Installation exited 0 and added 182 packages. Only `fs-ext@2.1.1` ran its
`node-gyp configure build` lifecycle script, ending with `gyp info ok`.
The script-policy listing returned `{"allowScripts":[]}` (no undecided scripts);
it is not a history of scripts executed. The foreground install output is that
evidence. The dependency/policy diff was empty.

Keep the committed lockfile, `.npmrc`, and `package.json` allowlist intact.
`npm ci` replaces `node_modules`; do not keep hand edits there. Do not replace it
with an unlocked install, disable strict policy, or skip the required native
build. `--no-audit --no-fund` avoids those ancillary requests; this install is
not a dependency vulnerability audit. An empty-cache installation was not tested;
the source operator runbook covers preparation with package-source access.

## Build and targeted tests

```bash
mise exec node@24.20.0 -- npm run typecheck
mise exec node@24.20.0 -- npm run build
mise exec node@24.20.0 -- node --test dist/test/unit/director.test.js dist/test/unit/mock-provider.test.js dist/test/unit/provider-definitions.test.js dist/test/contract/provider-definitions-parity.test.js dist/test/packaging/source-clean-host.test.js
mise exec node@24.20.0 -- node scripts/ios/generate-provider-definitions.mjs --check
```

Typecheck and build exited 0. The targeted run passed **35 tests, 0 failed,
0 skipped**, covering bounded scheduling, deterministic mock replies, provider
definitions, fixture rejection paths, and source-preflight/script-policy gates.
Rebuild before rerunning compiled tests after source changes.

The final command is the **Phase 5.2 provider-definition fixture parity check**.
It exited 0 without output from the checker. It compares the canonical shared
TypeScript definitions with
`contracts/iphone-alpha-native-bridge-v1/provider-definitions.json`.
`--check` is read-only and needs no Xcode or Swift; it does not run native iOS
tests or verify Phase 5.3 transport. The parity tests also reject changed,
missing, noncanonical, and unknown-field fixtures in disposable temporary data.

No provider credentials, running model server, or live provider calls are needed.
The selected tests use local fixtures and mock replies. With the caches above,
this workflow needs no live network calls; it does not invoke provider smoke
tests, application setup, deployment, or native iOS builds.

## Failures and safe recovery

- **Sandbox subprocess failures:** the first targeted run reported only
  `test failed`; a diagnostic run exposed `preflight_tool_unavailable: npm is
  required` and an empty-output strict-policy assertion. The identical targeted
  command passed all 35 tests after approval to run outside the agent sandbox.
  Request scoped execution permission when subprocesses are blocked; preserve
  the checks. A mise `tool purgatory cleanup failed: Read-only file system`
  warning also occurred inside the sandbox while version/build commands passed.
- **Strict script policy:** the passing tests confirm `ESTRICTALLOWSCRIPTS`
  (or `strict allow scripts`) blocks an unreviewed script before execution.
  Stop for dependency review; do not broaden the allowlist to make setup pass.
- **Fixture drift:** the checker reports `provider definitions fixture is not
  canonical or is stale; run with --write`. Stop and review the source/fixture
  change with its owner. Do not follow that write suggestion for a documentation
  task or regenerate provider/iOS files merely to silence a failure.
- **Missing tools, cache entries, or a native-module ABI mismatch:** verify the
  selected versions first. With the prerequisites/caches available, rerun the
  locked install above under Node 24, then rebuild. If offline installation
  cannot proceed, arrange approved dependency/header preparation; do not change
  global Node, delete the lockfile, or use privileged package installation as a
  shortcut. These missing-cache/ABI failures were not encountered in this run.
- **Observed nonfatal warnings:** npm reported deprecated `uuid@7.0.3`, and GCC
  reported `-Wcast-function-type` warnings in `fs-ext`. Installation still exited
  0; leave dependency upgrades to a separate reviewed change.

Before sharing evidence, review the diff and redact private paths, account
details, and credentials from tool output. Native build logs contain absolute
paths: do not commit or paste raw logs. Keep changes uncommitted until the
requested diff review is approved.
