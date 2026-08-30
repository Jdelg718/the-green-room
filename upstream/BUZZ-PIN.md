# Buzz upstream pin

Phase 0A uses an immutable upstream revision rather than a moving branch.

## Pinned revision

| Field | Value |
| --- | --- |
| Repository | [`block/buzz`](https://github.com/block/buzz) |
| Commit | [`eed74bde2f4797714335ac10c56c0b0244c1def4`](https://github.com/block/buzz/commit/eed74bde2f4797714335ac10c56c0b0244c1def4) |
| Commit date | `2026-08-29T19:14:28-04:00` |
| Subject | `feat(buzz-agent): surface stop reason and silent-turn WARN in telemetry (#7038)` |
| License at the pin | [Apache License 2.0](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/LICENSE) |

## Reproduce the checkout

```bash
git clone https://github.com/block/buzz.git buzz
cd buzz
git checkout --detach eed74bde2f4797714335ac10c56c0b0244c1def4
test "$(git rev-parse HEAD)" = "eed74bde2f4797714335ac10c56c0b0244c1def4"
git status --short
```

The final command should print nothing. The Phase 0A checkout met that condition before verification.

For an additional content check, the pinned checkout produced:

```text
5065cb3ccd26fb3e49306dfcdab9e2b3d9ed0aa25df5f39194a84f641c796bfa  Cargo.lock
b0b85d5ed8ef27992a9a434b78bc2ff4cd8cc94e807c5e642b6d8dd6e06daa34  pnpm-lock.yaml
108cb15997e51b75a8d18b0c1e2c52bd3879d051ab02118973387df1e4aab584  LICENSE
```

Verify the checkout against the recorded values with:

```bash
sha256sum --check <<'SHA256SUMS'
5065cb3ccd26fb3e49306dfcdab9e2b3d9ed0aa25df5f39194a84f641c796bfa  Cargo.lock
b0b85d5ed8ef27992a9a434b78bc2ff4cd8cc94e807c5e642b6d8dd6e06daa34  pnpm-lock.yaml
108cb15997e51b75a8d18b0c1e2c52bd3879d051ab02118973387df1e4aab584  LICENSE
SHA256SUMS
```

All three lines should report `OK`. Checksums detect local drift in these files; the commit SHA remains the authoritative pin.

## Scope

This pin records a feasibility baseline. It does not vendor Buzz, select a permanent integration strategy, deploy a service, or imply production readiness. If Buzz source is later incorporated, preserve its Apache-2.0 license and required notices.

The source revision is immutable, but the pinned checkout's Compose file uses mutable image tags such as `postgres:17-alpine`, `redis:7-alpine`, and several `latest` tags. A future service startup therefore produces fresh evidence for the images resolved at that time; it is not an exact reproduction of the Phase 0A environment unless every image is separately pinned by digest.

See the [local runbook](../docs/runbooks/local-buzz.md) and [Phase 0 evidence](../evidence/phase-0/README.md).
