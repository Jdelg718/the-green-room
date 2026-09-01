# Project governance

Green Room welcomes focused, respectful contributions from people with different experience levels. The project is currently maintained by Amy through the `@Jdelg718` GitHub account. This lightweight model keeps decisions clear while the maintainer group is small; it is a stewardship role, not a promise that every proposal will be accepted or answered on a fixed schedule.

## Participation and triage

Maintainers triage reports on their technical merits and project fit. We ask everyone to discuss the work rather than the person, assume good faith while addressing concrete harm, and make room for clarifying questions. Harassment, targeted abuse, credential disclosure, or posting another person's private data is not acceptable.

Issues may be labeled by type, area, status, and severity. Severity reflects user impact, exploitability, data exposure, and availability—not how loudly a report is argued. Maintainers may close duplicates with a pointer to the canonical issue, close spam or unsafe disclosures, request a narrower proposal, or defer work that does not fit the roadmap. Closing an issue is a scope decision, not a judgment of the contributor.

Do not disclose secrets or suspected vulnerabilities in public issues, pull requests, logs, screenshots, or persona packs. Follow [SECURITY.md](SECURITY.md) for private reporting. Maintainers may remove exposed material from public view while preserving only the minimum information needed for review.

## Contributions and licensing

Contributions accepted into this repository are governed by the repository's [Apache License 2.0](LICENSE), including its contribution terms. Green Room does not currently require a separate CLA or DCO. Contributors must have authority to submit their work and must identify third-party code, text, images, audio, persona material, and other assets with their provenance and applicable terms. See [Content and Legal Boundaries](docs/CONTENT-BOUNDARIES.md).

Private local imports are not project approval. Persona packs are untrusted, declarative, non-executable data. Repository presence is not Official Catalog admission, and maintainers may hold or remove content while rights, provenance, fidelity, privacy, or safety concerns are reviewed.

## Review and acceptance

A maintainer decides whether a change is accepted after considering:

- project scope and a coherent ensemble experience;
- focused tests and actual verification evidence, including the required `release-gate` for `main`;
- security and privacy, especially local ownership of data, provider-key handling, constrained provider endpoints, and untrusted input;
- compatibility with Node 24, the Python validator, stored rooms, documented APIs, and persona-pack schemas;
- user and contributor documentation, failure paths, and maintainability; and
- provenance, licenses, permissions, and content rights.

Review may ask for changes or independent subject-matter review. CODEOWNERS routes review to `@Jdelg718`, but branch protection does not currently require a GitHub approval and contributors should not treat routing as automatic acceptance. The maintainer resolves the final merge decision and should explain material scope or safety concerns concisely.

## Conflicts and escalation

Anyone reviewing work should disclose a material personal, financial, employment, authorship, or rights-holder conflict that could affect the decision. For a dispute concerning Amy's conduct, submitted content, or another material conflict, Amy recuses from the merits decision and asks a neutral trusted reviewer with relevant technical, safety, community, or rights expertise to make and document the recommendation. Amy may implement that recommendation and take immediate, reversible steps needed to contain a security, privacy, or rights risk. If no suitable reviewer is available, the disputed change or admission remains on hold rather than being approved by the conflicted maintainer. Security reports remain private during escalation.

## Releases and maintainers

Absent a recusal under the conflict process above, Amy currently has final authority for merges, Official Catalog admission, release contents, signing, publication, and rollback. Passing automation is necessary but does not itself authorize a release.

Trusted maintainers may be added gradually after sustained constructive contributions, sound review judgment, respect for security and content boundaries, reliable handling of private information, and agreement on the project's local-first direction. Access should begin with the least privilege needed, be documented publicly when appropriate, and expand only after demonstrated stewardship. Maintainer access may be reduced or removed to protect users or the project, with a concise explanation when safety and privacy allow.
