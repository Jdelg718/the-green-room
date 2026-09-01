# ADR 0003: Portable characters and reviewed community library

- **Status:** Proposed
- **Date:** 2026-09-01
- **Decision owners:** Green Room maintainers

## Context

The verified local alpha contains twelve source-informed historical character directories and can place one to three of them in a durable room. Product direction now requires three connected experiences:

1. researched historical characters ship prebuilt with the local application;
2. a guided Character Wizard lets users create original characters without editing YAML or Markdown by hand; and
3. a community library lets people discover, share, download, and install portable character packs.

The current integration has converged several previously overlapping workstreams:

- the executable historical runtime merged through PR #56;
- the strict, non-extracting `.greenroom` validator merged through PR #37 and integrated through PR #70;
- the bounded Node sidecar and inspection boundary merged through PRs #63 and #64;
- the reviewed Character Wizard UX exploration; and
- the reviewed programmable-character/flaw-state contract.

These must converge on one pack format. A wizard-only JSON export, a runtime-only historical directory, a separately versioned character program, and a community-specific archive would create incompatible products and multiple security boundaries.

The current Official Persona Catalog Policy deliberately prohibits project-operated hosting or indexing of unofficial community packs until maintainers approve a separate policy at least as strict as the official gate. Community hosting therefore requires an explicit staged boundary rather than an upload form bolted onto the public site.

## Decision

### One portable artifact

The canonical portable character artifact is the bounded, declarative `.greenroom` archive defined by the Persona Pack Specification and admitted by the integrated strict validator.

- Character Wizard output MUST validate as this artifact.
- Local import MUST use the same validator before any extraction, persistence, prompt assembly, or provider call.
- Community artifacts MUST use the same format and validation gate.
- Programmable-character state MAY extend a future schema version or project deterministically into canonical runtime files, but MUST NOT define a parallel archive or bypass validation.
- Character packs remain data. They cannot contain scripts, executables, symlinks, tools, provider credentials, room transcripts, memories, or arbitrary network configuration.

### Installed historical cast

The local application ships with twelve repository-controlled historical candidate packs:

Ada Lovelace, Benjamin Franklin, Elizabeth I, Frederick Douglass, Galileo Galilei, George Washington, Isaac Newton, Jane Austen, Leonardo da Vinci, Mary Shelley, Nicolaus Copernicus, and Thomas Jefferson.

They are source-informed educational interpretations, not literal simulations. The verified alpha may include and run exact repository versions while public release still fails closed on the Official Catalog Manifest gate. Public packaging requires version-and-digest-specific catalog admission, complete provenance, historical/content review, provenance/rights review, and the required educational interpretation label. The 12 approved pinned AI-generated portraits may ship as website and local-app presentation assets with accessible fallbacks and honest labeling, but that use does not admit a pack or asset to the Official Catalog; portrait redistribution inside downloadable packs remains held for its exact asset-manifest and catalog gates.

Neither the preinstalled/default cast nor a project-operated catalog may use copyrighted entertainment-franchise packs, copied scripts, actor images, cloned voices, or unreviewed likenesses. Community provenance or a compatible license does not create an exception to the separately accepted content and rights policy.

### Wizard boundary

The Character Wizard is served by the trusted local application, not the public website. It guides identity, role, voice, goals, virtues, flaws, pressure behavior, knowledge domains and limits, boundaries, relationships, scenarios, provenance, license, and optional reviewed assets.

The wizard:

1. keeps drafts local;
2. never stores provider keys, room transcripts, or memories in a character;
3. shows generated files and safety boundaries before export;
4. validates the exact generated archive;
5. supports rehearsal with synthetic/local scenarios without granting tools;
6. exports one deterministic `.greenroom` archive; and
7. distinguishes private draft, locally installed, community submitted, community reviewed, and official project status.

Browser local storage is not the durable source of truth. Draft persistence belongs to the local runtime and follows its backup/export/delete model.

### Local-first and provider boundary

Character authoring, validation, inspection, installation, and draft persistence run in the local companion. They do not require a Green Room account or project-operated service. Provider selection remains behind the local BYO-provider adapters defined by ADR 0002: a user-selected provider may receive only the bounded room/persona context required for inference, while `greenroomai.net`, catalog infrastructure, and character packs receive no provider credentials or model requests. A pack cannot select an arbitrary provider endpoint, add request headers, or expand the host-enforced tool and network boundary.

### Community library boundary

No project-operated repository, service, website, or catalog may host, index, mirror, or redistribute a community pack until maintainers separately review and accept `docs/COMMUNITY-PACK-POLICY.md`. Accepting this ADR records architecture and product direction; it does not itself satisfy that policy gate.

The community policy MUST be at least as strict as the Official Persona Catalog Policy and MUST preserve its public-domain-or-project-original asset boundary. It also requires original pack prose, version-and-digest-specific admission, independent content/safety and provenance/rights reviews by distinct non-author reviewers, conflict-of-interest disclosure, and hold-by-default treatment for unresolved rights, provenance, safety, or portrayal questions. A compatible license, permission claim, community authorship, or validator pass is not automatic admission.

After that policy is accepted, the first community library is GitHub-backed and static. It does not accept anonymous executable uploads and does not introduce Green Room accounts.

A submission is a reviewed repository change plus candidate bytes admitted through a maintainer-approved quarantine step. Registry CI MUST NOT fetch a contributor-controlled URL. The intake step copies the exact candidate bytes into a project-controlled quarantine and records their SHA-256 and byte length before validation. CI may retrieve only by content digest from a catalog-owned, allowlisted immutable origin. The origin must support direct HTTPS retrieval without credentials or redirects; if a hosting product cannot provide that contract, it is not eligible for automated intake.

Every intake and download connection resolves and classifies all A/AAAA results immediately before connection, rejects mixed or non-global address sets and every loopback/private/link-local/metadata/reserved/multicast/broadcast class, pins one validated address while preserving TLS hostname verification, verifies the connected peer, ignores ambient proxies, and enforces request/response byte, connect, header, idle, absolute-time, concurrency, and decompression limits. Any untrusted change to an artifact identity, quarantine object, or fetched location requires fresh maintainer approval, regardless of contributor history.

CI performs bounded validation and emits catalog metadata. Maintainers review provenance, license, content boundaries, safety, and rights before publication.

The public catalog publishes metadata and immutable artifact references only. Search/filtering runs over deterministic static JSON. Pack Markdown is not rendered as trusted HTML.

Every published version records at least:

- canonical pack ID and strict version;
- schema version, name, summary, identity type, tags, and author display;
- immutable artifact SHA-256, byte size, URL, and publication timestamp;
- source repository and exact commit;
- pack license, provenance status, asset rights records, and content cautions;
- validator version and validation evidence;
- review status, trust tier, review records, and decision date; and
- superseded, held, revoked, or tombstoned state.

Published versions are immutable. A changed pack requires a new version and digest. Revocation does not delete history silently; clients receive an authenticated tombstone and refuse new installation while retaining local user control over already installed data.

The first public catalog release uses TUF-style authenticated metadata. The local application pins reviewed root metadata. Offline threshold root keys authorize delegated targets keys; targets cover exact artifact identities, digests, review/trust decisions, and tombstones; signed snapshot and timestamp metadata bind a monotonic catalog revision and bounded expiry. Clients update and verify root metadata first, then timestamp, snapshot, and targets; reject expired metadata, rollback, revision reuse, missing tombstones, and stale/freeze conditions; and persist the highest accepted versions. Artifact SHA-256 remains mandatory but does not substitute for authenticated catalog metadata. Author signatures, when added later, identify an author and never upgrade review status.

### Trust tiers

User interfaces keep these visibly distinct:

1. **Preinstalled project candidate/approved** — exact repository version, with Official Catalog status shown separately.
2. **Community reviewed** — passed the community policy and exact-version review; not project-authored or officially endorsed.
3. **Local unreviewed** — created or imported privately; validation establishes structure, not truth, safety, rights, or endorsement.

No author signature, download count, or compatible license automatically upgrades a pack's trust tier.

### Local install flow

Community installation is explicit:

1. verify the authenticated catalog envelope and resolve an immutable catalog entry;
2. download only from its catalog-owned content-addressed origin under the no-redirect, DNS/IP/peer, proxy, byte, time, and concurrency policy above;
3. verify expected SHA-256 before parsing;
4. run the strict non-extracting validator;
5. show identity, version, author, license, provenance, content cautions, trust tier, files, assets, and validation diagnostics;
6. require user approval;
7. persist an immutable local copy plus catalog evidence;
8. never update silently; and
9. support disable, delete, export, and rollback.

The public catalog never receives local provider keys, transcripts, rooms, memory, private wizard drafts, model requests, or installed-pack inventories.

### Moderation and takedown

Initial submissions use pull requests and maintainer review. Reports use GitHub issues for non-sensitive matters and private security/legal channels for credentials, private data, vulnerability details, or sensitive rights claims.

Maintainers can hold, delist, revoke, or tombstone exact versions. The catalog keeps reason codes and dates without publishing sensitive report content. Emergency holds fail closed for new installs and updates.

## Consequences

### Positive

- One archive contract connects authoring, validation, import, runtime, and community distribution.
- The local-first privacy boundary remains intact.
- GitHub provides review history and immutable metadata commits. Approved artifact bytes live only on the separate project-controlled content-addressed origin defined above.
- Trust status, provenance, and version identity remain inspectable.
- A future API can preserve the same catalog objects rather than replacing them.

### Costs and limitations

- The strict validator, sidecar, and bounded inspection flow are integrated; inspection remains non-installing, and the separate explicit local pack store/install flow still must be implemented.
- The Character Wizard prototype is design input, not production wizard code, until storage and export align with this ADR.
- The programmable-character contract includes a schema and deterministic projection oracle, but runtime state work remains future work and the design does not itself install or execute packs.
- Community review is maintainer-intensive and deliberately slower than anonymous publishing.
- Static search and GitHub submission are less convenient than a marketplace but materially reduce account, moderation, storage, and abuse risk.
- The twelve historical candidates cannot be labeled Official Catalog entries until the existing manifest/review gate passes.

## Rejected alternatives

### Separate wizard, runtime, and community formats

Rejected because every format adds conversion ambiguity, validation drift, and a new security boundary.

### Anonymous upload service for launch

Rejected because it creates malware, rights, moderation, storage, identity, abuse, and incident-response obligations before the pack contract and local installer are complete.

### Treat valid syntax as project endorsement

Rejected. Structural validation cannot establish historical fidelity, authorship, safety, provenance, rights, or suitability.

### Store drafts or character state on greenroomai.net

Rejected. Wizard drafts and installed characters belong to the local runtime and its user-controlled data lifecycle.
