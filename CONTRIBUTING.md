# Contributing

The Green Room has a verified private/local alpha and is moving toward a downloadable local-first release. Contributions should keep the ensemble coherent, the runtime inspectable, and local ownership of data and credentials explicit.

## Workflow

1. Open or claim an issue before substantial work and name the owner.
2. Create one focused branch and, for parallel work, one dedicated worktree.
3. Confirm file ownership and hand off before editing another lane's shared files.
4. Keep provider-specific behavior behind adapters and add tests for behavior changes.
5. Run the repository's documented verification commands and record actual output.
6. Open a pull request describing intent, implementation, evidence, failure paths, and risks.
7. Do not merge your own change without review.

## Verification and release gate

The ordinary Node/UI development check remains:

```bash
npm run check
```

Python validator changes can be checked independently with `npm run check:python`.
Before a hybrid Node/Python release, start from clean installs and run the exact
release gate:

```bash
npm ci --strict-allow-scripts=true && uv sync --locked && npm run check:release
```

`check:release` runs `check:all` and then the first-playable acceptance.
`check:all` runs the Node check first, then Python `pytest`, Ruff formatting and
lint checks, and mypy. Every stage is joined with `&&`, so an install, Node,
Python, or acceptance failure is returned immediately rather than hidden by a
later command.

GitHub runs the same clean-install sequence for pull requests to `main` and
pushes to `main`. The required job also runs Bandit against the Python source
and audits the locked Python environment for known dependency vulnerabilities.
Branch protection requires the `release-gate` status check.

## Local-first and provider rules

- The local runtime owns room data, provider configuration, and credentials.
- Never put credentials in browser storage, URLs, SQLite room data, events, logs, diagnostics, exports, packs, fixtures, screenshots, or public issues.
- Provider keys may be entered only through loopback/native local setup and must never be collected by `greenroomai.net` or other hosted website code.
- Use opaque local secret references, redact failures, and disclose when a selected cloud provider receives bounded room context.
- Do not add arbitrary request URLs. Provider endpoints and any advanced custom-endpoint path must follow the accepted SSRF policy in [ADR 0002](docs/adr/0002-local-first-byo-llm-and-buzz-boundary.md).
- Preserve the deterministic director and runtime-enforced turn, cancellation, and budget limits.

## Parallel-agent discipline

- One agent owns a task, branch, worktree, and file set at a time.
- Avoid simultaneous edits to `package.json`, the lockfile, migrations, central schemas, routes, or app composition; the integration owner assigns and merges those changes.
- Rebase a lane immediately before review, let the original owner resolve its conflicts, and merge or cherry-pick one reviewed unit at a time.
- Read `AGENTS.md` and the active plan before editing. Read-only researchers and reviewers do not become opportunistic writers.

Suggested branch prefixes include `agent/`, `docs/`, and `spike/`.

## Persona and artwork contributions

Read [Content and Legal Boundaries](docs/CONTENT-BOUNDARIES.md) and the [Official Persona Catalog Policy](docs/PERSONA-CATALOG.md). Submit persona text and visual assets through the catalog review path. An asset stays a candidate until item-level provenance and rights, required independent reviews, and exact digest approval are recorded. Random web images, upstream assets covered only by a repository software license, and generated images without documented authorship and terms are not shippable.

Private local import is not project approval, and repository presence is not Official Catalog admission.

## Commit messages

Use concise conventional commits where possible:

```text
docs: clarify local provider boundary
feat: add persona manifest validator
test: cover director cooldown behavior
fix: stop autonomous turn loop after cancellation
```

## Governance and security

Project triage, review criteria, licensing boundaries, escalation, and release authority are documented in [GOVERNANCE.md](GOVERNANCE.md).

Do not open public issues containing vulnerabilities, secrets, private room transcripts, personal data, or private-infrastructure details. Follow [SECURITY.md](SECURITY.md) and use the repository's [private vulnerability-reporting form](https://github.com/Jdelg718/the-green-room/security/advisories/new).
