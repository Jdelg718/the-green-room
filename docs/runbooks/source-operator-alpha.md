# Source operator alpha

## Claim boundary

This is an operator workflow from a reviewed source checkout. It is not a relocatable package, installer, supported downloadable build, or clean-host acceptance result. The authorized evidence targets are **macOS 14+ on Apple silicon** and **Ubuntu 24.04 x64**. Neither target is recorded as passed by this runbook; clean standard-user VM evidence remains a separate gate.

Windows inspection remains intentionally unavailable, and no conclusion about other macOS versions, Intel Macs, Linux distributions, or architectures may be inferred from these instructions.

## Prerequisites

- A clean checkout at the exact reviewed commit, with no `node_modules/`, `.venv/`, or `dist/`.
- Native Node **24.x** (`node --version` must report `v24.…`).
- `uv` with network access to the locked Python package sources.
- Network access to the locked npm package sources.
- Native build prerequisites for the locked `fs-ext` writer-lock dependency: Xcode Command Line Tools on macOS; Python 3, `make`, and a C/C++ compiler (for example Ubuntu's `build-essential`) on Ubuntu. This requirement remains until a reviewed packaged payload supplies its own native lock implementation.
- Standard-user write access to the checkout and to a new, absolute, canonical data-root path.

The setup uses `npm ci --strict-allow-scripts=true --foreground-scripts` and `uv sync --locked --no-dev`. The foreground lifecycle log is required evidence that only the reviewed pinned `fs-ext@2.1.1` native script ran. It does not copy a virtual environment, and the resulting checkout is not relocatable.

## Preflight and prepare

Choose a disposable, absent data-root path. The preflight is shell-free Node code: it invokes `uv` directly, does not run a shell, and does not create dependencies, build output, or the data root.

```bash
node scripts/source-clean-host.mjs --data-root="$HOME/greenroom-operator-alpha-data"
npm ci --strict-allow-scripts=true --foreground-scripts
npm install-scripts ls --json
uv sync --locked --no-dev
npm run build
```

A successful preflight emits one JSON object with `code: "source_clean_host_preflight_ok"`. Failures emit a stable `preflight_*` code and exit nonzero. The preflight rejects a non-Node-24 runtime, unavailable/unparseable `uv`, missing lockfiles, prepared artifacts, an existing data root, a relative or noncanonical path, a symlinked parent, or a parent that is not writable.

## Start

```bash
GREENROOM_DATA_DIR="$HOME/greenroom-operator-alpha-data" npm run start:local
```

`start:local` resolves the checkout validator to an absolute executable. The server binds to loopback by default, acquires the data-root writer lock before validator directories or SQLite are opened, and exits with `data_root_in_use` if another writer owns that root.

For deterministic private acceptance, use the repository acceptance command separately:

```bash
npm run acceptance
```

This is source acceptance, not clean-host evidence for either named OS and not packaged-payload evidence.

## Stop and cleanup

Stop the foreground server with `Ctrl-C` and wait for it to exit. A normal stop closes HTTP, validator children, SQLite, and then the writer lock. The `.greenroom-writer.lock` metadata file may remain; its contents are diagnostic only, and kernel lock ownership—not a PID record—controls access.

After stopping, remove only the disposable path you chose and verified above. Never copy `.venv` into another checkout or package. Uninstall, retained-data, backup/restore, migration rollback, and purge behavior remain later lifecycle gates.

## Evidence still required

The manual **Clean-source evidence** GitHub workflow is `workflow_dispatch` only. Dispatch it from protected `main` after this workflow is merged. It requires GitHub's `github.ref_protected` value to be exactly `true`, records that fact, and rejects an unprotected `main` dispatch. Each matrix job creates a separate temporary non-admin user, makes a fresh public clone, and checks out the **exact dispatched protected-main SHA** in detached mode; because adding the workflow changes `main`, the older implementation base is not an evidence target. GitHub-hosted runners are fresh VMs with preinstalled host software, not blank OS images, and the evidence records that limitation.

For each named target, release evidence must record the exact OS build/architecture and dispatched protected-main SHA, then run `npm ci --strict-allow-scripts=true --foreground-scripts`, require exact `npm install-scripts ls --json` output with no unreviewed scripts, perform locked `uv` sync, build, foreign-CWD start/readiness, real validator inspection, SIGTERM process/listener cleanup, first-playable acceptance with restart continuity, and the scoped source-phase write audit. The source phase uses a synthetic home, checkout, caches, temporary files, evidence, and disposable data beneath one exact work root. A fail-closed before/after snapshot compares canonical path, type, ownership, mode, device/inode/link count, size/mtime, regular-file SHA-256, and symlink targets for paths owned by the fresh UID across recorded same-device roots; scan errors or incomplete coverage fail the run, as do creations, modifications, ownership changes, or deletions outside the work root. Root account/toolchain provisioning happens before the baseline and is explicitly outside scope: this is not a host-wide audit and does not claim detection of changes to paths owned by other UIDs, which the unprivileged source user normally cannot alter. The workflow uploads deterministic JSON and command logs, but this repository change does not claim either target passed: only a completed run at the newly merged protected-main SHA can supply that evidence.
