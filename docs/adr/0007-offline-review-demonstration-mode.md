# ADR 0007: Offline review demonstration mode

- Status: Accepted
- Date: 2026-09-18
- Decision owners: Green Room maintainers

## Context

Apple rejected external TestFlight build 3 under Guideline 2.1(a) because review could not exercise the app without independently supplied BYOK provider access. Green Room has no account system and must not invent an App Store account, bundle a provider credential, relax the fixed-endpoint boundary, or require Apple to obtain a paid third-party credential.

## Decision

The iPhone app provides an explicitly labeled **Review Demo** entry point. Opting in creates a distinct room whose immutable `inference_mode` is `review_demo`. Existing and ordinary rooms remain `provider`; there is no transition that changes a room between modes.

A demonstration turn uses the same bundled character roster, deterministic director, ordered event log, protected SQLite database, draft lifecycle, room list, and relaunch projection as an ordinary room. It differs only at reply production:

- reply text is selected deterministically from a bounded, bundled local set;
- the reply is prefixed `Demonstration reply (offline)` and the room carries a persistent visual Demonstration Mode banner;
- one SQLite transaction commits the director snapshot and human/director/persona event triplet;
- the path calls only the closed native database bridge and performs no provider transport, endpoint selection, model request, credential operation, Keychain operation, or network request;
- output is bounded to 700 UTF-8 bytes and accepts only bundled persona identifiers;
- normal BYOK rooms fail closed if the demonstration completion API is invoked.

The user can leave Demonstration Mode by returning to the ordinary new-room picker. The saved demonstration room remains reopenable and visibly identified. Leaving does not convert it into a provider room.

## Security invariants

1. `rooms.inference_mode` is constrained to `provider | review_demo` and immutable after insertion.
2. Existing databases migrate with `provider` as the default; no existing room becomes a demo.
3. Every demo mutation statement requires an active `review_demo` room, exact generation/sequence fences, current-room authority, and valid human/persona membership.
4. The provider settings control is disabled while a demo room is open.
5. Demo operation requires only protected local data availability. Network reachability and provider readiness are irrelevant.
6. Demo code contains no secret, credential reference, arbitrary endpoint, provider call, or network primitive.
7. BYOK behavior, consent, Keychain isolation, fixed provider destinations, and request fencing are unchanged.

## Consequences

Apple can create and reopen a room, exercise automatic and directed speaker choice over multiple turns, force-quit and relaunch, and leave the mode without an account, credential, or network. Replies demonstrate product mechanics rather than model quality and cannot be mistaken for live inference.

The demonstration mode is intentionally not a video, fake sign-in, hidden reviewer bypass, hosted service, or general offline language model. Its deterministic local text is product-limited and labeled accordingly.
