# ADR 0000: Hosting Placement for the Private Alpha

- **Status:** Accepted for Phase 0/private alpha
- **Date:** 2026-08-30
- **Decision:** Host the first shared Green Room relay and runtime on an existing private x86_64 Docker host, accessible only through the operator's private network. Move to dedicated infrastructure before public access or sustained community use.

> Exact host identity, network addresses, paths, port assignments, capacity readings, neighboring workloads, and operator procedures are intentionally excluded from this public repository. They belong in a private operations runbook.

## Requirements

The provisional Buzz-based deployment needs:

- x86_64 Linux;
- Docker Compose 2.24.4 or newer;
- relay/application service;
- dedicated Postgres, Redis, and object-storage services;
- Green Room director/persona runtime;
- persistent volumes and backups;
- private network access during the alpha;
- enough headroom to survive agent bursts without harming neighboring services.

Model inference remains external. Local LLM serving is not part of the alpha.

## Placement rationale

The selected alpha host already provides:

- a supported container runtime and current Compose implementation;
- sufficient available memory and SSD headroom for a bounded alpha;
- private overlay networking;
- administrative access, monitoring, and backup support;
- low current CPU load.

The selected host is shared with important services. That failure-domain concentration is the principal risk and makes strict isolation, resource caps, and a reversible deployment mandatory.

Other existing candidates were rejected because they had one or more of the following problems:

- high disk utilization;
- a memory-heavy primary agent workload;
- missing container tooling or constrained administration;
- workstation rather than server availability;
- production business workloads requiring complete isolation.

## Deployment boundary

The private alpha must use:

- a uniquely named Compose project;
- an operator-defined host directory documented only in the private runbook;
- dedicated internal networks, service accounts, credentials, and named volumes;
- dedicated Postgres, Redis, and object-storage containers—never another application's data services;
- relay publishing only on loopback and/or a private overlay-network address;
- no `0.0.0.0` or `[::]` publishing;
- an admin surface that is disabled or loopback-only;
- no public tunnel or public DNS route during Phase 0;
- pinned image digests or immutable commit-based tags;
- an aggregate initial memory cap of approximately 4–5 GiB;
- explicit CPU and memory limits on every component, especially Redis and the director/persona runtime;
- object-storage quotas and Postgres retention controls;
- health checks, bounded restart policies, log rotation, and centralized service logs;
- encrypted, automated Postgres and object-storage backups stored off-host, with a verified restore test before alpha data is admitted;
- a documented one-command shutdown and rollback path;
- monitoring for relay liveness, host memory, disk and inode pressure, I/O latency, and container restarts;
- least-privilege service credentials stored outside images and source control.

## Stop conditions

Pause or remove the deployment if any of these occur:

- host available memory repeatedly falls below the private runbook's safety floor;
- root-disk utilization exceeds 75%;
- Green Room causes latency or restart instability in neighboring services;
- Green Room exceeds its configured resource caps;
- the relay requires public exposure before authentication, rate limits, backups, and adversarial testing are complete.

## Public-hosting trigger

Provision a dedicated Green Room host before any of the following:

- public internet access;
- untrusted user registration or pack uploads;
- regular use by people outside the private network;
- sustained rooms or background agents;
- resource demand above roughly 2 CPUs, 6 GiB RAM, or 40 GiB persistent storage;
- availability expectations that make shared-host maintenance coupling unacceptable.

A suitable dedicated starting size is 4 vCPU, 16 GiB RAM, and at least 160–200 GiB SSD, managed through a private overlay network. Add public ingress only after a reviewed reverse proxy or tunnel, authentication, rate limits, backup/restore verification, and adversarial testing are complete.

## Consequences

**Positive:** The alpha can begin without purchasing infrastructure while remaining private and reversible.

**Negative:** A shared host creates blast-radius risk. This is a staging decision, not permanent production placement.
