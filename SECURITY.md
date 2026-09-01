# Security Policy

## Reporting a vulnerability

Do not publish credentials, private room transcripts, infrastructure details, personal data, or exploit instructions in a public issue.

Use the repository's [private **Report a vulnerability** form](https://github.com/Jdelg718/the-green-room/security/advisories/new) under GitHub's **Security → Advisories** area. It creates a private report visible to repository maintainers; do not first open a public issue or include the report in public discussion.

## Repository hygiene

- Never commit `.env` files, credentials, API keys, private keys, Nostr secret keys, production addresses, internal hostnames, or private operations runbooks.
- Use placeholders in examples and keep real values in the deployment's secret manager.
- Treat persona packs and archives as untrusted input.
- Rotate any credential exposed in Git history; deleting the file is not sufficient.
- Keep private deployment details in an operator-controlled runbook outside this public repository.

## Supported versions

The project is pre-alpha. No released version currently receives security support.
