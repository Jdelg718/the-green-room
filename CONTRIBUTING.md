# Contributing

The Green Room is in planning and feasibility work. Contributions should make the first playable room smaller, clearer, safer, or more fun.

## Workflow

1. Open or claim an issue before substantial work.
2. Create a focused branch from `main`.
3. Keep changes small and documented.
4. Add or update tests with behavior changes.
5. Run the repository's documented verification commands.
6. Open a pull request describing intent, implementation, evidence, and risks.
7. Do not merge your own change without review once code work begins.

## Agent collaboration

Amy, Skip, and other coding agents should:

- identify themselves in commits or PR notes when practical;
- read `AGENTS.md` and the active plan before editing;
- avoid simultaneous edits to the same files without an explicit handoff;
- record tested commands and actual results;
- never claim a test, build, or deployment passed without real output;
- use branches and pull requests rather than pushing competing work directly to `main`.

Suggested branch prefixes:

- `amy/`
- `skip/`
- `agent/`
- `docs/`
- `spike/`

## Content contributions

Only original or properly licensed persona content belongs in this repository. Read [Content and Legal Boundaries](docs/CONTENT-BOUNDARIES.md) before proposing a persona pack.

## Commit messages

Use concise conventional commits where possible:

```text
docs: clarify phase 0 exit criteria
feat: add persona manifest validator
test: cover director cooldown behavior
fix: stop autonomous turn loop after cancellation
```

## Security

Do not open public issues containing vulnerabilities, secrets, private room transcripts, or personal data. A private reporting channel will be documented before executable releases.
