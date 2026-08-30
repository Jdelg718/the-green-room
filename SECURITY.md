# Security Policy

## Reporting a vulnerability

Do not publish credentials, private room transcripts, infrastructure details, personal data, or exploit instructions in a public issue.

Use GitHub's private vulnerability-reporting or security-advisory workflow when available. If it is unavailable, contact the repository owner through GitHub without including sensitive details and request a private channel.

## Repository hygiene

- Never commit `.env` files, credentials, API keys, private keys, Nostr secret keys, production addresses, internal hostnames, or private operations runbooks.
- Use placeholders in examples and keep real values in the deployment's secret manager.
- Treat persona packs and archives as untrusted input.
- Rotate any credential exposed in Git history; deleting the file is not sufficient.
- Keep private deployment details in an operator-controlled runbook outside this public repository.

## Supported versions

The project is pre-alpha. No released version currently receives security support.
