## Summary

<!-- What changes, why it belongs in Green Room, and the issue it addresses. -->

Closes #

## Scope and risk

- User-visible behavior:
- Failure paths or rollback:
- Compatibility impact (Node 24, Python validator, stored rooms, persona-pack schemas):

## Green Room boundaries

Check every applicable statement; explain any exception above.

- [ ] The local runtime remains authoritative for room data and provider configuration.
- [ ] No provider key, credential, transcript, room event, personal data, or private-infrastructure detail is exposed or persisted improperly.
- [ ] Provider behavior stays behind an adapter, endpoints remain constrained by ADR 0002, and any cloud context disclosure is documented.
- [ ] Persona packs remain declarative, untrusted, and non-executable; no shell, filesystem, browser, credential, or messaging agency is granted by default.
- [ ] Submitted text, code, images, audio, and persona material have documented provenance and distribution rights; no unreviewed franchise, likeness, voice-clone, or random web content is included.
- [ ] Documentation and tests cover the changed behavior, or the omission is explained.

## Verification evidence

<!-- Paste commands and concise real results. Do not paste secrets or private data. -->

- [ ] I ran the relevant focused tests/checks.
- [ ] I ran the exact clean-install Node 24 hybrid gate, or explained why a maintainer must run it:

```bash
npm ci && uv sync --locked && npm run check:release
```

Result:

<!-- `release-gate` is the required GitHub status check for main. -->

## Review notes

- Security/privacy considerations:
- Documentation/provenance notes:
- Follow-up work intentionally left out:
