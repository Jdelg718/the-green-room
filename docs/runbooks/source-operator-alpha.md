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

The setup uses `npm ci --strict-allow-scripts=true` and `uv sync --locked --no-dev`. It does not copy a virtual environment, and the resulting checkout is not relocatable.

## Preflight and prepare

Choose a disposable, absent data-root path. The preflight is shell-free Node code: it invokes `uv` directly, does not run a shell, and does not create dependencies, build output, or the data root.

```bash
node scripts/source-clean-host.mjs --data-root="$HOME/greenroom-operator-alpha-data"
npm ci --strict-allow-scripts=true
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

For each named target, release evidence must record the exact OS build/architecture and source commit, then run `npm ci --strict-allow-scripts=true`, locked `uv` sync, build, start/readiness, first-playable acceptance, validator inspection, restart, and understood cleanup from a clean standard-user host. This repository change does not claim those runs occurred.
