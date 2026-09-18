# Apple Beta App Review instructions — Green Room 0.1.0 (5)

## Review access

**Sign-in required: No.** Green Room has no account or sign-in system. No demo account or provider credential is required for the review path below.

## Exact offline demonstration steps

1. Launch **The Green Room**.
2. Tap **Review Demo** in the top navigation.
3. Confirm the purple notice labeled **Review Demonstration Mode · explicit opt-in**.
4. Select one to three bundled characters, then tap **Create Demonstration Room**.
5. Confirm the room shows **Demonstration Mode · Offline** and explains that replies are deterministic local demonstrations, not model inference.
6. Leave **To** set to **Anyone — director chooses**, enter a line, and tap **Send atomic turn**. The director automatically selects one eligible character and the ordered human/director/character triplet is stored locally.
7. In **To**, select a named character, send another line, and confirm that exact character replies.
8. Send additional turns if desired. Each local reply begins **Demonstration reply (offline)**. No provider, credential, Keychain access, or network connection is used.
9. Open **Rooms**, reopen the demonstration room, and confirm the transcript remains present.
10. Force-quit and relaunch the app; the same room, mode label, and transcript reopen from protected local storage.
11. Tap **Leave Demonstration Mode** to return to ordinary room creation. This does not convert the saved demonstration room into a provider-backed room.

The demonstration is fully functional app behavior: room creation, bundled cast selection, deterministic automatic/directed speaker scheduling, atomic ordered turns, durable persistence, room reopening, and relaunch recovery. It is not a video or fake login.

## Optional normal BYOK flow

Normal rooms remain separate and unchanged. A tester may open **Provider**, choose one of the five fixed providers, enter a model ID, review and accept the exact data-use disclosure, and save a credential in the native Keychain sheet. Green Room provides no credential and operates no account, analytics collector, model proxy, transcript service, or relay. Provider requests go directly to the selected fixed HTTPS provider after consent. This optional path is not needed to exercise the core app during review.

## Safety and identity

- App: The-Green-Room
- Bundle: `net.greenroomai.GreenRoom`
- Version/build: `0.1.0 (5)`
- Minimum iOS: 18.6; iPhone only
- Public TestFlight link: disabled/forbidden
- App Store production submission: not part of this beta review
