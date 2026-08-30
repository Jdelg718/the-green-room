# Reproduce the pinned Buzz baseline locally

This runbook separates the source build, which can run without services, from local service startup, which requires Docker Engine and the Compose v2 plugin.

The immutable revision is recorded in [the Buzz pin](../../upstream/BUZZ-PIN.md).

## Prerequisites

- Git
- A supported Linux or macOS development host
- Network access for the initial clone and dependency downloads
- For service startup only: a running Docker daemon and `docker compose` (Compose v2)

Buzz carries a Hermit environment in `bin/`. Activating it supplies the pinned development tools; no global Rust, Node.js, pnpm, or just installation is required.

## 1. Clone and verify the immutable revision

```bash
git clone https://github.com/block/buzz.git buzz
cd buzz
git checkout --detach eed74bde2f4797714335ac10c56c0b0244c1def4
test "$(git rev-parse HEAD)" = "eed74bde2f4797714335ac10c56c0b0244c1def4"
git status --short
```

`git status --short` should print nothing.

## 2. Activate the supplied toolchain

```bash
source ./bin/activate-hermit
node --version
cargo --version
rustc --version
pnpm --version
just --version
```

The Phase 0A run resolved Node.js `v24.15.0`, Cargo/Rust `1.95.0`, pnpm `11.4.0`, and just `1.46.0` through Hermit.

## 3. Build the source baseline

```bash
just build
```

At the pinned revision, this recipe runs:

```bash
cargo build --workspace
```

Verified Phase 0A result:

```text
Finished `dev` profile [unoptimized + debuginfo] target(s) in 8m 06s
elapsed=488.852
exit=0
```

This proves the pinned Rust workspace compiled in the verification environment. It does **not** prove that Postgres, Redis, the relay, web UI, or desktop application started successfully.

## 4. Run the focused infrastructure-free check

After the workspace build, Phase 0A ran one focused unit test rather than the large full suite:

```bash
cargo test -p buzz-core --lib \
  channel::tests::channel_names_trim_whitespace_and_drop_all_leading_hashes \
  -- --exact --nocapture
```

Verified result:

```text
running 1 test
test channel::tests::channel_names_trim_whitespace_and_drop_all_leading_hashes ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 261 filtered out
exit=0
```

The focused rerun used already-populated build artifacts and completed in `0.491s`. It requires no Docker services.

## 5. Start local services when Docker is available

Check both required Docker capabilities first:

```bash
docker info
docker compose version
```

Only when both commands succeed, run:

```bash
just setup
```

`just setup` invokes `./scripts/dev-setup.sh`, which starts Docker services, waits for health, runs migrations, and installs desktop dependencies.

In the Phase 0A execution environment, this step was attempted and blocked before service startup:

```text
Docker version 26.1.5+dfsg1, build a72d7cd
docker: 'compose' is not a docker command.
Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
[dev-setup] Docker daemon is not running. Start Docker Desktop and try again.
error: Recipe `setup` failed on line 50 with exit code 1
elapsed=1.152
exit=1
```

Install/enable Compose v2 and start the Docker daemon, then rerun the two capability checks and `just setup`. Do not treat the successful source build as a successful service startup.

## Safety

Use only local development defaults and public-safe placeholders. Do not paste credentials into commands, commit a generated `.env`, expose services publicly, or point this feasibility run at shared infrastructure.

The complete result and limitations are recorded in [Phase 0 evidence](../../evidence/phase-0/README.md).
