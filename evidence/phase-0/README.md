# Phase 0A evidence: pinned Buzz baseline

## Result

**Partial baseline verified.** The exact pinned Buzz source revision built successfully, and one focused infrastructure-free unit test passed. Local service startup was honestly attempted but could not begin because this execution environment lacks both a Docker Compose v2 plugin and a running Docker daemon.

This evidence supports source-level feasibility only. It is not evidence of a running Buzz stack, integration success, deployment, or production readiness.

The checkout's `docker-compose.yml` references mutable image tags rather than immutable digests. Any future service startup is fresh evidence for the images resolved on that date, not exact reproduction of this baseline, unless all service images are first digest-pinned.

## Subject under test

- Upstream: [`block/buzz`](https://github.com/block/buzz)
- Revision: [`eed74bde2f4797714335ac10c56c0b0244c1def4`](https://github.com/block/buzz/commit/eed74bde2f4797714335ac10c56c0b0244c1def4)
- Pin record: [`upstream/BUZZ-PIN.md`](../../upstream/BUZZ-PIN.md)
- Reproduction instructions: [`docs/runbooks/local-buzz.md`](../../docs/runbooks/local-buzz.md)
- Verification date: `2026-08-30`

The checkout was detached at the recorded SHA and `git status --short` was empty before verification.

## Toolchain observed

Hermit supplied the repository-pinned development tools:

```text
node v24.15.0
cargo 1.95.0
rustc 1.95.0
pnpm 11.4.0
just 1.46.0
```

The host exposed Docker CLI `26.1.5+dfsg1`; it did not expose the Compose command or a reachable daemon.

## Commands and actual results

### Immutable checkout

```bash
git clone https://github.com/block/buzz.git buzz
cd buzz
git checkout --detach eed74bde2f4797714335ac10c56c0b0244c1def4
git rev-parse HEAD
git status --short
```

Result:

```text
eed74bde2f4797714335ac10c56c0b0244c1def4
# git status --short printed no entries
exit=0
```

### Portable checksum verification

The recorded manifest was checked against the pinned files with both supported command forms available in the verification environment:

```bash
sha256sum --check <<'SHA256SUMS'
5065cb3ccd26fb3e49306dfcdab9e2b3d9ed0aa25df5f39194a84f641c796bfa  Cargo.lock
b0b85d5ed8ef27992a9a434b78bc2ff4cd8cc94e807c5e642b6d8dd6e06daa34  pnpm-lock.yaml
108cb15997e51b75a8d18b0c1e2c52bd3879d051ab02118973387df1e4aab584  LICENSE
SHA256SUMS

shasum -a 256 --check <<'SHA256SUMS'
5065cb3ccd26fb3e49306dfcdab9e2b3d9ed0aa25df5f39194a84f641c796bfa  Cargo.lock
b0b85d5ed8ef27992a9a434b78bc2ff4cd8cc94e807c5e642b6d8dd6e06daa34  pnpm-lock.yaml
108cb15997e51b75a8d18b0c1e2c52bd3879d051ab02118973387df1e4aab584  LICENSE
SHA256SUMS
```

Both commands returned `OK` for `Cargo.lock`, `pnpm-lock.yaml`, and `LICENSE` with exit status `0`. This verifies the GNU/Linux and native macOS checksum paths use a mutually compatible manifest format.

### Source build

```bash
source ./bin/activate-hermit
just build
```

`just build` expanded to `cargo build --workspace`.

Result:

```text
Finished `dev` profile [unoptimized + debuginfo] target(s) in 8m 06s
elapsed=488.852
exit=0
```

The build completed in the original background process after the first agent's reporting window expired. Recovery inspected and retained that successful result; it did not repeat the eight-minute build.

### Focused unit test

```bash
cargo test -p buzz-core --lib \
  channel::tests::channel_names_trim_whitespace_and_drop_all_leading_hashes \
  -- --exact --nocapture
```

Result:

```text
Finished `test` profile [unoptimized + debuginfo] target(s) in 0.38s
running 1 test
test channel::tests::channel_names_trim_whitespace_and_drop_all_leading_hashes ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 261 filtered out; finished in 0.00s
elapsed=0.491
exit=0
```

### Service setup attempt

This historical attempt reached Buzz's Docker-daemon preflight and failed before daemon resources were changed. It is recorded as evidence, not as a command sequence to repeat. Future operators must use the [runbook's side-effect disclosure and fail-closed Docker preflight](../../docs/runbooks/local-buzz.md#5-start-local-services-when-docker-is-available) before any `just setup` invocation.

```bash
source ./bin/activate-hermit
just setup
```

Result:

```text
[dev-setup] Docker daemon is not running. Start Docker Desktop and try again.
error: Recipe `setup` failed on line 50 with exit code 1
elapsed=1.152
exit=1
```

Capability checks confirmed both environmental blockers:

```bash
docker --version
docker compose version
docker info
```

```text
Docker version 26.1.5+dfsg1, build a72d7cd
docker: 'compose' is not a docker command.
Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
```

### Fail-closed preflight regression verification

The literal setup block was extracted from the runbook and executed in an isolated temporary directory with shell-function mocks for `docker`, `just`, and acknowledgement reads. No real Docker command or daemon was contacted. The failure case made mocked `docker compose version` exit `23` while all three acknowledgement responses were available on standard input; the block exited nonzero before requesting any acknowledgement, and the event log contained no `just setup`. Before the fix, the same regression check failed because the block returned `0` and invoked `just setup`.

The success case used only successful mocks and required this exact event order: context selection, context inspection, daemon information, Compose version, all three acknowledgements, then `just setup`.

```text
PASS: compose failure blocks just setup
PASS: success-path command ordering is exact
```

## Verification matrix

| Check | Result | Meaning |
| --- | --- | --- |
| Exact upstream SHA | Pass | Immutable source baseline identified |
| Clean tracked checkout | Pass | No source edits were needed to build |
| GNU/Linux `sha256sum --check` | Pass | All three recorded file hashes matched |
| macOS `shasum -a 256 --check` | Pass | All three recorded file hashes matched with the portable manifest |
| `cargo build --workspace` via `just build` | Pass | Pinned Rust workspace compiles |
| Focused `buzz-core` unit test | Pass | One infrastructure-free behavior check executes successfully |
| Mocked fail-closed setup preflight | Pass | A Compose failure prevents acknowledgements and `just setup`; successful mocks preserve the reviewed order |
| `just setup` | Blocked | No Compose v2 plugin and no running Docker daemon |
| Postgres/Redis migrations and service health | Not run | Depend on successful Docker startup |
| Full unit/integration/E2E suites | Not run | Outside this bounded recovery; integration requires services |
| Shared deployment | Not run | Explicitly excluded from Phase 0A |

## Next action

On a local development host with Docker Engine running and Compose v2 installed, follow the [local runbook](../../docs/runbooks/local-buzz.md). Review all setup side effects, verify a local or dedicated disposable Docker context, confirm legacy `sprout-*` containers are disposable, review `.env`, and only then run the guarded setup flow. Capture resolved image digests, service health, and integration-test results as fresh evidence before making an architecture or production-readiness decision.
