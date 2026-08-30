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

Verify the recorded lockfile and license hashes. GNU/Linux normally provides `sha256sum`; native macOS provides `shasum`. This selects the available implementation and refuses to continue if neither exists:

```bash
if command -v sha256sum >/dev/null 2>&1; then
  checksum=(sha256sum --check)
elif command -v shasum >/dev/null 2>&1; then
  checksum=(shasum -a 256 --check)
else
  printf '%s\n' 'Refusing: neither sha256sum nor shasum is available.' >&2
  exit 1
fi

"${checksum[@]}" <<'SHA256SUMS'
5065cb3ccd26fb3e49306dfcdab9e2b3d9ed0aa25df5f39194a84f641c796bfa  Cargo.lock
b0b85d5ed8ef27992a9a434b78bc2ff4cd8cc94e807c5e642b6d8dd6e06daa34  pnpm-lock.yaml
108cb15997e51b75a8d18b0c1e2c52bd3879d051ab02118973387df1e4aab584  LICENSE
SHA256SUMS
```

All three lines should report `OK`. The two-space manifest format works with both commands; macOS users do not need to install GNU coreutils.

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

### Side effects at the pinned commit

Do not run `just setup` until you have reviewed and accepted all of these effects:

- It acts on the daemon selected by the active Docker context (or by `DOCKER_HOST`). A wrong selection can modify a shared or remote daemon.
- It can stop and remove fixed-name legacy containers named `sprout-postgres`, `sprout-redis`, `sprout-adminer`, `sprout-keycloak`, `sprout-minio`, `sprout-minio-init`, and `sprout-prometheus`. Their volumes are preserved, but the containers themselves must be disposable.
- It starts persistent `buzz-*` development containers and named volumes, binds loopback host ports, and configures containers with `restart: unless-stopped`.
- Its `bootstrap` prerequisite downloads pinned development tools when absent, creates `.env` from `.env.example` when absent, and generates a relay private key in `.env` when one is absent.
- It runs database migrations and local seed data, and installs pnpm dependencies for the desktop and web workspaces.
- It replaces this checkout's local `core.hooksPath` and force-installs Git hooks into the shared Git hooks directory.

### Generate and review `.env` without touching a Docker daemon

`just bootstrap` does not contact or mutate a Docker daemon. It does download tools and create or update the gitignored `.env` as described above:

```bash
just bootstrap
test -f .env
test "$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)" = "600"
less .env
```

Review every active value and keep only local-development endpoints and public-safe placeholders. Do not paste the generated relay private key into logs, issues, or chat. Stop here if `.env` references shared infrastructure or if any value is not understood.

### Fail-closed Docker preflight and setup

The block below repeats all checks immediately before setup. Its verification commands are read-only: they do not list, stop, remove, create, or start daemon resources. `DOCKER_HOST` must be unset so it cannot silently override the inspected context. The exact acknowledgements make an incomplete preflight fail closed.

Run it only after reviewing `.env` and deciding whether every fixed-name `sprout-*` container listed above is disposable:

```bash
(
  set -euo pipefail

  if [[ -n "${DOCKER_HOST:-}" ]]; then
    printf '%s\n' 'Refusing: unset DOCKER_HOST and inspect the intended Docker context.' >&2
    exit 1
  fi

  test -f .env || { printf '%s\n' 'Refusing: generate and review .env first.' >&2; exit 1; }

  context="$(docker context show)" || {
    printf '%s\n' 'Refusing: could not determine the active Docker context.' >&2
    exit 1
  }
  printf 'Active Docker context: %s\n' "$context"
  docker context inspect "$context" || {
    printf '%s\n' 'Refusing: could not inspect the active Docker context.' >&2
    exit 1
  }
  docker info || {
    printf '%s\n' 'Refusing: the selected Docker daemon is unavailable.' >&2
    exit 1
  }
  docker compose version || {
    printf '%s\n' 'Refusing: Docker Compose v2 is unavailable.' >&2
    exit 1
  }

  read -r -p 'Type USE DISPOSABLE DOCKER CONTEXT to confirm the inspected daemon is local/dedicated and disposable: ' context_ack
  [[ "$context_ack" == 'USE DISPOSABLE DOCKER CONTEXT' ]] || { printf '%s\n' 'Aborted.' >&2; exit 1; }

  read -r -p 'Type LEGACY SPROUT CONTAINERS ARE DISPOSABLE to permit their stop/removal: ' legacy_ack
  [[ "$legacy_ack" == 'LEGACY SPROUT CONTAINERS ARE DISPOSABLE' ]] || { printf '%s\n' 'Aborted.' >&2; exit 1; }

  read -r -p 'Type ENV REVIEWED FOR LOCAL USE to confirm .env contains only approved local settings: ' env_ack
  [[ "$env_ack" == 'ENV REVIEWED FOR LOCAL USE' ]] || { printf '%s\n' 'Aborted.' >&2; exit 1; }

  just setup
)
```

Inspect `docker context inspect` before typing the first acknowledgement. Continue only when its Docker endpoint is a local socket or a dedicated, disposable development daemon that you are authorized to modify. Stop if it is shared, remote, production-like, or uncertain. Do not use `docker ps`, `docker compose up`, or any cleanup command to investigate an uncertain context; resolve the context outside this runbook first.

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

Install/enable Compose v2 and start a dedicated disposable Docker daemon, then repeat the complete fail-closed preflight and acknowledgement flow above. Do not treat the successful source build as a successful service startup.

The checkout is source-pinned, but `docker-compose.yml` uses mutable tags, including several `latest` tags. A future successful startup is fresh evidence for whatever image digests resolve then, not an exact reproduction of this baseline. Exact service reproduction requires recording and pinning every image by immutable digest before startup.

## Safety

Use only local development defaults and public-safe placeholders. Do not paste credentials into commands, commit a generated `.env`, expose services publicly, or point this feasibility run at shared infrastructure. Never run `just setup` merely to test whether an uncertain Docker context is safe.

The complete result and limitations are recorded in [Phase 0 evidence](../../evidence/phase-0/README.md).
