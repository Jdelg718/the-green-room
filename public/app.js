const ROOM_ID = "first-playable";
const ROOM_ACTIONS = new Set(["pause", "resume", "stop"]);
const PERSONA_ACTIONS = new Set(["mute", "unmute"]);
const PERSONA_ID = /^[a-z][a-z0-9-]{0,63}$/;

function sameOriginPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("A same-origin path is required");
  }
  return path;
}

export const API_PATHS = Object.freeze({
  bootstrap: "/api/bootstrap",
  catalog: "/api/catalog/personas",
  humanProfile: "/api/human-profile",
  cast: `/api/rooms/${ROOM_ID}/cast`,
  room: `/api/rooms/${ROOM_ID}`,
  events(after) {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TypeError("The event cursor must be a non-negative integer");
    }
    return sameOriginPath(`/api/rooms/${ROOM_ID}/events?after=${after}`);
  },
  stream(after) {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TypeError("The event cursor must be a non-negative integer");
    }
    return sameOriginPath(`/api/rooms/${ROOM_ID}/stream?after=${after}`);
  },
  messages: `/api/rooms/${ROOM_ID}/messages`,
  roomControl(action) {
    if (!ROOM_ACTIONS.has(action)) throw new TypeError("Unknown room control");
    return sameOriginPath(`/api/rooms/${ROOM_ID}/${action}`);
  },
  personaControl(personaId, action) {
    if (!PERSONA_ID.test(personaId) || !PERSONA_ACTIONS.has(action)) {
      throw new TypeError("Unknown persona control");
    }
    return sameOriginPath(`/api/rooms/${ROOM_ID}/personas/${personaId}/${action}`);
  },
});

export const EDUCATIONAL_NOTICE = "Educational creative interpretation. This AI persona is an original, source-informed interpretation of a historical person. It is not the person, an authoritative reconstruction, or an endorsed representative. Generated dialogue is not a historical quotation. Consult the cited sources for the record.";
const CATALOG_SIZE = 12;
const EXACT_CATALOG_KEYS = Object.freeze(["behavior", "educationalNotice", "identity", "knowledge", "name", "slug", "summary"]);
const EXACT_IDENTITY_KEYS = Object.freeze(["ageBand", "setting", "type"]);
const EXACT_BEHAVIOR_KEYS = Object.freeze(["agreeableness", "emotionalRange", "initiative", "interruption", "maxConsecutiveTurns", "verbosity"]);
const EXACT_KNOWLEDGE_KEYS = Object.freeze(["cutoff", "domains", "limitations"]);
const ORIGINAL_PERSONA_PRESENTATION = Object.freeze({
  detective: Object.freeze({ role: "Original persona · detective", temperament: "Perceptive, suspicious, and evidence-led" }),
  fixer: Object.freeze({ role: "Original persona · fixer", temperament: "Charming, pragmatic, and leverage-minded" }),
  optimist: Object.freeze({ role: "Original persona · optimist", temperament: "Organized, community-minded, and resolute" }),
});
export const HUMAN_EMOJIS = Object.freeze(["🙂", "😎", "🤓", "🧐", "😄", "🥳", "🧠", "🫡", "🦊", "🐸", "👻", "🤖"]);

// Portrait paths are application-owned and bound only to built-in canonical IDs.
// Catalog/persona data cannot provide or override image URLs.
export const TRUSTED_CHARACTER_PORTRAITS = Object.freeze({
  detective: Object.freeze({ src: "/assets/portraits/detective.webp", alt: "Original portrait of The Detective holding a notebook in a shadowed study.", objectPosition: "50% 30%" }),
  fixer: Object.freeze({ src: "/assets/portraits/fixer.webp", alt: "Original portrait of The Fixer holding a brass key in a dim workshop-office.", objectPosition: "50% 28%" }),
  optimist: Object.freeze({ src: "/assets/portraits/optimist.webp", alt: "Original portrait of The Optimist holding planning cards in a welcoming meeting room.", objectPosition: "50% 27%" }),
  "ada-lovelace": Object.freeze({ src: "/assets/portraits/ada-lovelace.webp", alt: "Creative historical portrait of Ada Lovelace in a dark study, wearing a high-collared black dress.", objectPosition: "50% 33%" }),
  "benjamin-franklin": Object.freeze({ src: "/assets/portraits/benjamin-franklin.webp", alt: "Creative historical portrait of Benjamin Franklin in a brown coat, holding spectacles in a dim workshop.", objectPosition: "50% 36%" }),
  "elizabeth-i": Object.freeze({ src: "/assets/portraits/elizabeth-i.webp", alt: "Creative historical portrait of Elizabeth I in a red embroidered gown and white ruff.", objectPosition: "50% 32%" }),
  "frederick-douglass": Object.freeze({ src: "/assets/portraits/frederick-douglass.webp", alt: "Creative historical portrait of Frederick Douglass with swept gray hair and a dark formal suit.", objectPosition: "50% 25%" }),
  "galileo-galilei": Object.freeze({ src: "/assets/portraits/galileo-galilei.webp", alt: "Creative historical portrait of Galileo Galilei, white-bearded and seated beside books and a candle.", objectPosition: "50% 26%" }),
  "george-washington": Object.freeze({ src: "/assets/portraits/george-washington.webp", alt: "Creative historical portrait of George Washington in a dark blue Continental-era coat beside surveying instruments.", objectPosition: "50% 36%" }),
  "isaac-newton": Object.freeze({ src: "/assets/portraits/isaac-newton.webp", alt: "Creative historical portrait of Isaac Newton in a dark coat, seated at a candlelit desk.", objectPosition: "50% 38%" }),
  "jane-austen": Object.freeze({ src: "/assets/portraits/jane-austen.webp", alt: "Creative historical portrait of Jane Austen in a modest cap and dark shawl beside a writing desk.", objectPosition: "50% 29%" }),
  "leonardo-da-vinci": Object.freeze({ src: "/assets/portraits/leonardo-da-vinci.webp", alt: "Creative historical portrait of Leonardo da Vinci, white-bearded with one hand raised in thought.", objectPosition: "50% 48%" }),
  "mary-shelley": Object.freeze({ src: "/assets/portraits/mary-shelley.webp", alt: "Creative historical portrait of Mary Shelley in a black period dress at a storm-lit writing desk.", objectPosition: "50% 32%" }),
  "nicolaus-copernicus": Object.freeze({ src: "/assets/portraits/nicolaus-copernicus.webp", alt: "Creative historical portrait of Nicolaus Copernicus in a red-and-black scholar’s robe beside astronomical notes.", objectPosition: "50% 29%" }),
  "thomas-jefferson": Object.freeze({ src: "/assets/portraits/thomas-jefferson.webp", alt: "Creative historical portrait of Thomas Jefferson in a dark period coat in an architectural study.", objectPosition: "50% 31%" }),
});

function characterMonogram(displayName) {
  const letters = typeof displayName === "string"
    ? displayName.trim().split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 3).toLocaleUpperCase()
    : "";
  return letters || "?";
}

export function characterPortraitIdentity(personaId, displayName) {
  const trusted = typeof personaId === "string" && Object.hasOwn(TRUSTED_CHARACTER_PORTRAITS, personaId)
    ? TRUSTED_CHARACTER_PORTRAITS[personaId]
    : undefined;
  return Object.freeze({
    trusted: trusted !== undefined,
    src: trusted?.src ?? null,
    alt: trusted?.alt ?? "",
    objectPosition: trusted?.objectPosition ?? "50% 35%",
    monogram: characterMonogram(displayName),
  });
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys) {
  return plainRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function boundedText(value, maximum = 2_000) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function horizonFromCutoff(cutoff) {
  const years = cutoff.match(/(?:^|\D)(1[0-9]{3})(?![0-9])/g)?.map((part) => Number(part.match(/[0-9]{4}/)?.[0])) ?? [];
  const year = years.at(-1);
  if (!Number.isInteger(year)) return "Other documented horizon";
  if (year < 1600) return "Before 1600";
  if (year < 1700) return "1600–1699";
  if (year < 1800) return "1700–1799";
  return "1800–1899";
}

export function behaviorLabels(behavior) {
  if (!exactKeys(behavior, EXACT_BEHAVIOR_KEYS) ||
    ["initiative", "interruption", "verbosity", "agreeableness", "emotionalRange"].some((key) =>
      typeof behavior[key] !== "number" || !Number.isFinite(behavior[key]) || behavior[key] < 0 || behavior[key] > 1) ||
    !Number.isSafeInteger(behavior.maxConsecutiveTurns) || behavior.maxConsecutiveTurns < 1 || behavior.maxConsecutiveTurns > 10) {
    throw new TypeError("Invalid behavior controls");
  }
  const initiative = behavior.initiative < 1 / 3 ? "Reserved initiative" : behavior.initiative < 2 / 3 ? "Responsive initiative" : "High initiative";
  const challenge = behavior.agreeableness < 1 / 3 ? "Direct challenger" : behavior.agreeableness < 2 / 3 ? "Independent challenger" : "Collaborative challenger";
  const interruption = behavior.interruption < 1 / 3 ? "Waits for the floor" : behavior.interruption < 2 / 3 ? "Balanced turn-taking" : "May press to interject";
  return Object.freeze([initiative, challenge, interruption]);
}

function validateStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 &&
    value.every((item) => boundedText(item, 1_000)) && new Set(value).size === value.length;
}

export function validateCatalogDto(value) {
  if (!Array.isArray(value) || value.length !== CATALOG_SIZE) throw new TypeError("Invalid catalog response");
  const slugs = new Set();
  const personas = value.map((persona) => {
    if (!exactKeys(persona, EXACT_CATALOG_KEYS) || !PERSONA_ID.test(persona.slug) || slugs.has(persona.slug) ||
      !boundedText(persona.name, 128) || !boundedText(persona.summary) || persona.educationalNotice !== EDUCATIONAL_NOTICE ||
      !exactKeys(persona.identity, EXACT_IDENTITY_KEYS) || !boundedText(persona.identity.type, 128) ||
      !boundedText(persona.identity.ageBand, 128) || !boundedText(persona.identity.setting, 1_000) ||
      !exactKeys(persona.knowledge, EXACT_KNOWLEDGE_KEYS) || !boundedText(persona.knowledge.cutoff, 256) ||
      !validateStringArray(persona.knowledge.domains) || !validateStringArray(persona.knowledge.limitations)) {
      throw new TypeError("Invalid catalog response");
    }
    const labels = behaviorLabels(persona.behavior);
    slugs.add(persona.slug);
    return Object.freeze({
      slug: persona.slug, name: persona.name, summary: persona.summary,
      identity: Object.freeze({ ...persona.identity }), behavior: Object.freeze({ ...persona.behavior }),
      knowledge: Object.freeze({ ...persona.knowledge, domains: Object.freeze([...persona.knowledge.domains]), limitations: Object.freeze([...persona.knowledge.limitations]) }),
      educationalNotice: persona.educationalNotice, status: "candidate · draft",
      horizon: horizonFromCutoff(persona.knowledge.cutoff), behaviorLabels: labels,
    });
  });
  return Object.freeze(personas);
}

export function validateBootstrapDto(value) {
  if (!exactKeys(value, ["capabilities", "csrfToken"]) ||
    !boundedText(value.csrfToken, 512) ||
    !exactKeys(value.capabilities, ["personaPackInspection"]) ||
    typeof value.capabilities.personaPackInspection !== "boolean") {
    throw new RequestFailure("invalid_response");
  }
  return value;
}

export function validateHumanProfileDto(value) {
  if (!exactKeys(value, ["emoji"]) || !HUMAN_EMOJIS.includes(value.emoji)) {
    throw new RequestFailure("invalid_response");
  }
  return value;
}

export function catalogFilterOptions(catalog) {
  return Object.freeze({
    horizons: Object.freeze([...new Set(catalog.map(({ horizon }) => horizon))].sort()),
    domains: Object.freeze([...new Set(catalog.flatMap(({ knowledge }) => knowledge.domains))].sort((a, b) => a.localeCompare(b))),
  });
}

export function filterCatalog(catalog, filters) {
  const query = typeof filters.query === "string" ? filters.query.trim().toLocaleLowerCase() : "";
  const horizon = filters.horizon ?? "all";
  const domain = filters.domain ?? "all";
  return catalog.filter((persona) => {
    const searchable = [persona.name, persona.summary, persona.identity.type, persona.identity.ageBand,
      persona.identity.setting, ...persona.knowledge.domains, ...persona.knowledge.limitations,
      ...persona.behaviorLabels].join(" ").toLocaleLowerCase();
    return (!query || searchable.includes(query)) && (horizon === "all" || persona.horizon === horizon) &&
      (domain === "all" || persona.knowledge.domains.includes(domain));
  });
}

export function activePersonaPresentation(personaSlug, catalog) {
  const persona = catalog?.find((candidate) => candidate.slug === personaSlug);
  if (persona !== undefined) {
    return Object.freeze({
      role: `${persona.knowledge.domains[0]} · ${persona.horizon}`,
      temperament: persona.behaviorLabels.join(" · "),
    });
  }
  return ORIGINAL_PERSONA_PRESENTATION[personaSlug] ?? Object.freeze({
    role: `Original persona · ${personaSlug}`,
    temperament: "Original ensemble voice",
  });
}

export function createSelectionState(slugs = []) {
  if (!Array.isArray(slugs) || slugs.length > 3 || slugs.some((slug) => !PERSONA_ID.test(slug)) || new Set(slugs).size !== slugs.length) {
    throw new TypeError("Invalid selection state");
  }
  return Object.freeze({ slugs: Object.freeze([...slugs]) });
}

export function historicalSelectionFromRoom(room, catalog) {
  const known = new Set(catalog.map(({ slug }) => slug));
  return createSelectionState(room.participants
    .filter(({ kind, personaSlug }) => kind === "persona" && known.has(personaSlug))
    .map(({ personaSlug }) => personaSlug));
}

export function selectionAvailability(state) {
  const count = state.slugs.length;
  return Object.freeze({ count, full: count === 3, startDisabled: count === 0 });
}

export function addSelection(state, slug) {
  if (!PERSONA_ID.test(slug)) throw new TypeError("Invalid persona slug");
  if (state.slugs.includes(slug)) return state;
  if (state.slugs.length >= 3) throw new RangeError("Cast capacity is three personas");
  return createSelectionState([...state.slugs, slug]);
}

export function removeSelection(state, slug) {
  const index = state.slugs.indexOf(slug);
  if (index < 0) return Object.freeze({ state, focus: Object.freeze({ kind: "builder" }) });
  const slugs = state.slugs.filter((candidate) => candidate !== slug);
  const focus = slugs.length === 0 ? { kind: "builder" } : { kind: "remove", slug: slugs[Math.min(index, slugs.length - 1)] };
  return Object.freeze({ state: createSelectionState(slugs), focus: Object.freeze(focus) });
}

export function reserveCastStart(pending) {
  if (!(pending instanceof Set) || pending.size !== 0) return false;
  pending.add("cast");
  return true;
}

export function reserveMutation(pending, key) {
  if (!(pending instanceof Set) || !boundedText(key, 128) || pending.size !== 0) return false;
  pending.add(key);
  return true;
}

export async function initializeRoomBeforeCatalog(options) {
  if (typeof options?.bootstrapRoom !== "function" || typeof options?.loadCatalog !== "function") {
    throw new TypeError("Room and catalog initializers are required");
  }
  await options.bootstrapRoom();
  return Object.freeze({
    catalogAttempt: Promise.resolve().then(options.loadCatalog),
    retryCatalog: options.loadCatalog,
  });
}

export function restoreDialogTriggerFocus(trigger) {
  if (trigger?.isConnected && typeof trigger.focus === "function") trigger.focus();
}

export function createSessionCommit(sessionId, currentSessionId, commit) {
  if (!boundedText(sessionId, 128) || typeof currentSessionId !== "function" || typeof commit !== "function") {
    throw new TypeError("Invalid session event commit");
  }
  return (record) => {
    if (currentSessionId() === sessionId) commit(record);
  };
}

export const RECONNECT_DELAYS_MS = Object.freeze([500, 1_000, 2_000, 4_000, 8_000]);

const REASON_LABELS = Object.freeze({
  selected: "A cast member was selected.",
  cancelled: "The cue was cancelled.",
  unverified_event: "The director held the room.",
  duplicate: "A repeated cue was ignored.",
  self_trigger_blocked: "The room prevented an automatic reply loop.",
  budget_exhausted: "The room has reached its reply limit.",
  deliberate_silence: "A quiet beat was intentional.",
  no_persona: "No cast member is available.",
  no_eligible_persona: "Every cast member is muted.",
  cooldown: "The cast is taking a beat.",
});

export function reasonLabel(reason) {
  return REASON_LABELS[reason] ?? "The director held the room.";
}

function safeText(value) { return typeof value === "string" ? value : ""; }

function renderCharacterPortrait(personaId, displayName, options = {}, documentRoot = document) {
  const identity = characterPortraitIdentity(personaId, displayName);
  const portrait = documentRoot.createElement("span");
  portrait.className = `character-portrait ${options.className ?? "portrait-avatar"}`;
  const fallback = documentRoot.createElement("span");
  fallback.className = "portrait-fallback";
  fallback.textContent = options.fallbackText ?? identity.monogram;
  if (options.fallbackText) fallback.classList?.add("emoji-avatar");
  fallback.setAttribute?.("aria-hidden", "true");
  if (!identity.trusted) {
    portrait.append(fallback);
    return portrait;
  }
  const image = documentRoot.createElement("img");
  image.src = sameOriginPath(identity.src);
  image.alt = options.descriptive ? identity.alt : "";
  image.width = options.width ?? 96;
  image.height = options.height ?? 96;
  image.loading = options.eager ? "eager" : "lazy";
  image.decoding = "async";
  image.style.objectPosition = identity.objectPosition;
  fallback.hidden = true;
  image.onerror = () => { image.hidden = true; fallback.hidden = false; };
  portrait.append(image, fallback);
  return portrait;
}

export function renderTranscriptEvent(record, participantName, documentRoot = document, participantIdentity = () => null) {
  const event = record.event;
  const item = documentRoot.createElement("li");
  item.className = "transcript-item";
  item.dataset.sequence = String(record.sequence);
  const sequence = documentRoot.createElement("span");
  sequence.className = "event-sequence";
  sequence.textContent = `#${String(record.sequence).padStart(3, "0")}`;
  const body = documentRoot.createElement("div");
  body.className = "event-body";
  const speaker = documentRoot.createElement("h3");
  speaker.className = "event-speaker";
  const text = documentRoot.createElement("p");
  text.className = "event-text";
  body.append(speaker, text);
  if (event.type === "human_message") {
    item.classList.add("event-human");
    const participantId = safeText(event.participantId);
    const displayName = participantName(participantId);
    const identity = participantIdentity(participantId);
    body.prepend(renderCharacterPortrait(null, displayName, { className: "portrait-transcript", width: 72, height: 72, fallbackText: identity?.emoji }, documentRoot));
    speaker.textContent = displayName;
    text.textContent = safeText(event.text);
  } else if (event.type === "persona_message") {
    item.classList.add("event-persona");
    const participantId = safeText(event.participantId);
    const displayName = participantName(participantId);
    const identity = participantIdentity(participantId);
    body.prepend(renderCharacterPortrait(identity?.personaSlug, displayName, { className: "portrait-transcript", width: 72, height: 72 }, documentRoot));
    speaker.textContent = displayName;
    text.textContent = safeText(event.text);
  } else if (event.type === "director_decision") {
    const reason = safeText(event.reason);
    const reasonCopy = documentRoot.createElement("p");
    reasonCopy.className = "event-reason";
    reasonCopy.textContent = reasonLabel(reason);
    body.append(reasonCopy);
    if (typeof event.speaker === "string") {
      item.classList.add("event-director");
      speaker.textContent = "Director";
      text.textContent = `Cue: ${participantName(event.speaker)}.`;
    } else {
      item.classList.add("event-silence");
      speaker.textContent = "Silence";
      text.textContent = reasonLabel(reason);
    }
  } else {
    item.classList.add("event-director");
    speaker.textContent = "Room update";
    text.textContent = "The room recorded an update.";
  }
  item.append(sequence, body);
  return item;
}

export function createRequestId(kind, uuid = crypto.randomUUID()) {
  const safeKind = String(kind).replaceAll(/[^a-z0-9-]/g, "-").slice(0, 24) || "action";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new TypeError("A random UUID is required");
  }
  return `ui-${safeKind}-${uuid}`;
}

export function openStopConfirmation(dialog) {
  dialog.returnValue = "cancel";
  dialog.showModal();
}

export function controlAvailability(status, pending, _muted, personaId) {
  const stopped = status === "stopped";
  const mutationPending = pending.size !== 0;
  return Object.freeze({
    canCompose: status === "active" && !mutationPending,
    canPauseResume: !stopped && !mutationPending,
    canStop: !stopped && !mutationPending,
    canToggleMute: !stopped && !mutationPending,
  });
}

export function canSubmitMessage(status, pending, text, submitDisabled) {
  return !submitDisabled && text.trim().length > 0 && controlAvailability(status, pending).canCompose;
}

function validRecord(record) {
  return record !== null && typeof record === "object" && Number.isSafeInteger(record.sequence) &&
    record.sequence > 0 && record.event !== null && typeof record.event === "object" &&
    !Array.isArray(record.event);
}

export function createRoomEventChannel(options) {
  let cursor = 0;
  let connection = null;
  let timer = null;
  let attempt = 0;
  let stopped = true;
  let generation = 0;
  let controller = null;
  let catchUpOperation = null;
  const setTimer = options.setTimer ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timerId) => globalThis.clearTimeout(timerId));
  const connectionChange = options.onConnectionChange ?? (() => undefined);

  function isCurrent(operationGeneration) {
    return !stopped && generation === operationGeneration;
  }

  function commit(record, operationGeneration) {
    if (!isCurrent(operationGeneration)) return "stale";
    if (!validRecord(record) || record.sequence <= cursor) return "duplicate";
    if (record.sequence !== cursor + 1) return "gap";
    options.commit(record);
    cursor = record.sequence;
    return "committed";
  }

  async function catchUp(operationGeneration) {
    if (!isCurrent(operationGeneration)) return;
    if (catchUpOperation?.generation === operationGeneration) return catchUpOperation.promise;
    const operation = {
      generation: operationGeneration,
      promise: (async () => {
        connectionChange("catching-up");
        while (isCurrent(operationGeneration)) {
          const records = await options.fetchCatchUp(cursor, { signal: controller?.signal });
          if (!isCurrent(operationGeneration)) return;
          if (!Array.isArray(records)) throw new TypeError("Replay response is invalid");
          if (records.length === 0) return;
          for (const record of records) {
            if (!isCurrent(operationGeneration)) return;
            if (commit(record, operationGeneration) === "gap") {
              throw new Error("Replay sequence is incomplete");
            }
          }
        }
      })(),
    };
    catchUpOperation = operation;
    try {
      await operation.promise;
    } finally {
      if (catchUpOperation === operation) catchUpOperation = null;
    }
  }

  function scheduleReconnect(operationGeneration) {
    if (!isCurrent(operationGeneration) || timer !== null) return;
    connectionChange("reconnecting");
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    const scheduled = { id: null };
    timer = scheduled;
    scheduled.id = setTimer(() => {
      if (timer !== scheduled || !isCurrent(operationGeneration)) return;
      timer = null;
      void reconnect(operationGeneration);
    }, delay);
  }

  function disconnect(activeConnection, operationGeneration) {
    if (!isCurrent(operationGeneration) || connection !== activeConnection) return;
    connection = null;
    activeConnection.source?.close();
    scheduleReconnect(operationGeneration);
  }

  function attach(operationGeneration) {
    if (!isCurrent(operationGeneration) || connection !== null) return;
    const after = cursor;
    const activeConnection = { source: null };
    connection = activeConnection;
    let activeSource;
    try {
      activeSource = options.connect(after, {
        onOpen() {
          if (!isCurrent(operationGeneration) || connection !== activeConnection) return;
          attempt = 0;
          connectionChange("connected");
        },
        onEvent(record) {
          if (!isCurrent(operationGeneration) || connection !== activeConnection) return;
          if (commit(record, operationGeneration) === "gap") {
            disconnect(activeConnection, operationGeneration);
          }
        },
        onError() { disconnect(activeConnection, operationGeneration); },
      });
    } catch (error) {
      if (connection === activeConnection) connection = null;
      throw error;
    }
    activeConnection.source = activeSource;
    if (!isCurrent(operationGeneration) || connection !== activeConnection) {
      activeSource.close();
      if (connection === activeConnection) connection = null;
    }
  }

  async function reconnect(operationGeneration) {
    try {
      await catchUp(operationGeneration);
      if (!isCurrent(operationGeneration)) return;
      attach(operationGeneration);
    } catch {
      scheduleReconnect(operationGeneration);
    }
  }

  return Object.freeze({
    get cursor() { return cursor; },
    async start() {
      if (!stopped) return;
      stopped = false;
      const operationGeneration = ++generation;
      controller = typeof AbortController === "function" ? new AbortController() : null;
      await reconnect(operationGeneration);
    },
    async catchUp() { await catchUp(generation); },
    stop() {
      generation += 1;
      stopped = true;
      controller?.abort();
      controller = null;
      catchUpOperation = null;
      if (timer !== null) {
        clearTimer(timer.id);
        timer = null;
      }
      if (connection !== null) {
        const activeConnection = connection;
        connection = null;
        activeConnection.source?.close();
      }
      connectionChange("offline");
    },
  });
}

export function createRoomChannelHolder(initialChannel = null) {
  let channel = initialChannel;
  function assertChannel(nextChannel) {
    if (nextChannel === null || typeof nextChannel !== "object" ||
      typeof nextChannel.start !== "function" || typeof nextChannel.stop !== "function" ||
      typeof nextChannel.catchUp !== "function" || !Number.isSafeInteger(nextChannel.cursor) || nextChannel.cursor < 0) {
      throw new TypeError("Invalid room event channel");
    }
  }
  if (initialChannel !== null) assertChannel(initialChannel);
  return Object.freeze({
    get current() { return channel; },
    replace(nextChannel) {
      assertChannel(nextChannel);
      channel = nextChannel;
    },
    async start() { await channel?.start(); },
    async catchUp() { await channel?.catchUp(); },
    stop() { channel?.stop(); },
  });
}

export function bindRoomChannelLifecycle(channelHolder, target = globalThis) {
  if (channelHolder === null || typeof channelHolder !== "object" || !("current" in channelHolder)) {
    channelHolder = createRoomChannelHolder(channelHolder);
  }
  let disposed = false;
  let ready = false;
  let pageActive = true;
  let currentStarted = false;

  function assertChannel(channel) {
    const probe = createRoomChannelHolder();
    probe.replace(channel);
  }

  function stopCurrent() {
    if (!currentStarted) return;
    currentStarted = false;
    channelHolder.stop();
  }

  async function startIfActive() {
    if (!ready || !pageActive || disposed || currentStarted || channelHolder.current === null) return false;
    const channel = channelHolder.current;
    currentStarted = true;
    try {
      await channel.start();
      return true;
    } catch (error) {
      if (channelHolder.current === channel) currentStarted = false;
      throw error;
    }
  }

  function removeListeners() {
    if (disposed) return;
    disposed = true;
    target.removeEventListener("pagehide", onPageHide);
    target.removeEventListener("pageshow", onPageShow);
  }

  function onPageHide(event) {
    pageActive = false;
    stopCurrent();
    if (!event.persisted) removeListeners();
  }

  function onPageShow(event) {
    if (!event.persisted || disposed) return;
    pageActive = true;
    if (ready) void startIfActive().catch(() => undefined);
  }

  target.addEventListener("pagehide", onPageHide);
  target.addEventListener("pageshow", onPageShow);

  return Object.freeze({
    get isActive() { return pageActive && !disposed; },
    get isDisposed() { return disposed; },
    async activate() {
      ready = true;
      await startIfActive();
    },
    replace(channel) {
      assertChannel(channel);
      if (channelHolder.current === channel) return;
      stopCurrent();
      channelHolder.replace(channel);
      currentStarted = false;
    },
    startIfActive,
    suspend() {
      ready = false;
      stopCurrent();
    },
    dispose() {
      if (disposed) return;
      stopCurrent();
      removeListeners();
    },
  });
}

const STATUS_LABELS = Object.freeze({ active: "Active", paused: "Paused", stopped: "Stopped" });
const USER_ERRORS = Object.freeze({
  invalid_request: "That action could not be sent. Check the message and try again.",
  request_conflict: "The room changed before that action completed. Its latest state is shown.",
  generation_failed: "The room could not complete that cue. Please try again.",
  body_too_large: "That message is too long to send.",
  invalid_csrf: "The local session expired. Reload this page to continue.",
  invalid_origin: "The local server rejected this page origin.",
  invalid_host: "The local server rejected this page address.",
});

class RequestFailure extends Error {
  constructor(code) {
    super("The local request failed");
    this.name = "RequestFailure";
    this.code = code;
  }
}

function userMessage(error) {
  if (error instanceof RequestFailure) {
    return USER_ERRORS[error.code] ?? "The local room could not complete that action.";
  }
  return "The local room is unavailable. Check the server and try again.";
}

async function readJson(response) {
  let value;
  try { value = await response.json(); } catch { throw new RequestFailure("invalid_response"); }
  if (!response.ok) {
    const code = value !== null && typeof value === "object" && value.error !== null &&
      typeof value.error === "object" && typeof value.error.code === "string"
      ? value.error.code : "request_failed";
    throw new RequestFailure(code);
  }
  return value;
}

async function getJson(path, signal) {
  return readJson(await fetch(sameOriginPath(path), {
    method: "GET", credentials: "same-origin", headers: { Accept: "application/json" }, signal,
  }));
}

async function postJson(path, body, csrfToken) {
  return readJson(await fetch(sameOriginPath(path), {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(body),
  }));
}

export function validateRoomDto(value) {
  if (!exactKeys(value, ["generation", "id", "participants", "sessionId", "status", "title"]) || value.id !== ROOM_ID ||
    !boundedText(value.sessionId, 128) || !boundedText(value.title, 256) || !["active", "paused", "stopped"].includes(value.status) ||
    !Number.isSafeInteger(value.generation) || value.generation < 0 || !Array.isArray(value.participants) || value.participants.length < 1 || value.participants.length > 4) {
    throw new RequestFailure("invalid_response");
  }
  const ids = new Set();
  let humans = 0;
  for (const participant of value.participants) {
    const keys = participant?.kind === "persona" ? ["displayName", "id", "kind", "muted", "personaSlug"] : ["displayName", "id", "kind", "muted"];
    if (!exactKeys(participant, keys) || !boundedText(participant.id, 128) || ids.has(participant.id) ||
      !boundedText(participant.displayName, 128) || typeof participant.muted !== "boolean" ||
      (participant.kind !== "human" && participant.kind !== "persona") ||
      (participant.kind === "persona" && !PERSONA_ID.test(participant.personaSlug))) {
      throw new RequestFailure("invalid_response");
    }
    if (participant.kind === "human") humans += 1;
    ids.add(participant.id);
  }
  if (humans !== 1) throw new RequestFailure("invalid_response");
  return value;
}

export function validateCastResponse(value, { requestId, personaSlugs, oldSessionId }) {
  if (!exactKeys(value, ["kind", "requestId", "room", "selectedCast", "sessionId"]) || value.kind !== "cast" ||
    value.requestId !== requestId || !boundedText(value.sessionId, 128) || value.sessionId === oldSessionId ||
    !Array.isArray(value.selectedCast) || value.selectedCast.length !== personaSlugs.length) {
    throw new TypeError("Invalid cast response");
  }
  const roomValue = validateRoomDto(value.room);
  const humanParticipants = roomValue.participants.filter(({ kind }) => kind === "human");
  const personaParticipants = roomValue.participants.filter(({ kind }) => kind === "persona");
  if (roomValue.sessionId !== value.sessionId || roomValue.status !== "active" || roomValue.generation !== 0 ||
    humanParticipants[0]?.displayName !== "You" || humanParticipants[0]?.muted !== false ||
    personaParticipants.length !== personaSlugs.length) throw new TypeError("Invalid cast response");
  for (const [index, selected] of value.selectedCast.entries()) {
    if (!exactKeys(selected, ["name", "participantId", "slug", "sortOrder"]) || selected.slug !== personaSlugs[index] ||
      !boundedText(selected.participantId, 128) || !boundedText(selected.name, 128) || selected.sortOrder !== index + 1) {
      throw new TypeError("Invalid cast response");
    }
    const participant = personaParticipants[index];
    if (participant?.id !== selected.participantId || participant.personaSlug !== selected.slug || participant.displayName !== selected.name) {
      throw new TypeError("Invalid cast response");
    }
  }
  return value;
}

export function reconcileHistoricalRoomAttempt(options) {
  if (!boundedText(options?.requestId, 128) || !Array.isArray(options?.personaSlugs) ||
    options.personaSlugs.length < 1 || options.personaSlugs.length > 3 ||
    options.personaSlugs.some((slug) => !PERSONA_ID.test(slug)) ||
    !boundedText(options.oldSessionId, 128)) {
    throw new TypeError("Invalid historical room reconciliation");
  }
  if (options.response !== undefined) {
    try {
      const response = validateCastResponse(options.response, options);
      return Object.freeze({ kind: "committed", recovered: false, requestedCast: true, room: response.room });
    } catch { /* An authoritative room is required for an ambiguous response. */ }
  }
  if (options.authoritativeRoom === undefined) return Object.freeze({ kind: "unknown" });
  let room;
  try { room = validateRoomDto(options.authoritativeRoom); }
  catch { return Object.freeze({ kind: "unknown" }); }
  if (room.sessionId === options.oldSessionId) return Object.freeze({ kind: "unchanged", room });
  const authoritativeCast = room.participants.filter(({ kind }) => kind === "persona").map(({ personaSlug }) => personaSlug);
  const requestedCast = authoritativeCast.length === options.personaSlugs.length &&
    authoritativeCast.every((slug, index) => slug === options.personaSlugs[index]);
  return Object.freeze({ kind: "committed", recovered: true, requestedCast, room });
}

export async function transitionRoomSession(options) {
  const room = validateRoomDto(options.room);
  if (room.sessionId === options.oldSessionId) throw new TypeError("A replacement room must use a new session");
  const channel = options.createChannel(room.sessionId);
  if (channel.cursor !== 0) throw new TypeError("A new session channel must begin at cursor 0");
  if (options.lifecycle === null || typeof options.lifecycle?.replace !== "function" ||
    typeof options.lifecycle?.startIfActive !== "function") throw new TypeError("A room channel lifecycle is required");
  options.lifecycle.replace(channel);
  options.clearSession();
  options.renderRoom(room);
  await options.lifecycle.startIfActive();
  return Object.freeze({ sessionId: room.sessionId, channel });
}

export function safeDetailsContent(persona) {
  let expectedLabels;
  try { expectedLabels = behaviorLabels(persona?.behavior); } catch { throw new TypeError("Invalid safe details persona"); }
  if (!exactKeys(persona, ["behavior", "behaviorLabels", "educationalNotice", "horizon", "identity", "knowledge", "name", "slug", "status", "summary"]) ||
    !PERSONA_ID.test(persona.slug) || !boundedText(persona.name, 128) || !boundedText(persona.summary) ||
    persona.status !== "candidate · draft" || persona.educationalNotice !== EDUCATIONAL_NOTICE ||
    !exactKeys(persona.identity, EXACT_IDENTITY_KEYS) || !boundedText(persona.identity.type, 128) ||
    !boundedText(persona.identity.ageBand, 128) || !boundedText(persona.identity.setting, 1_000) ||
    !exactKeys(persona.knowledge, EXACT_KNOWLEDGE_KEYS) || !boundedText(persona.knowledge.cutoff, 256) ||
    !validateStringArray(persona.knowledge.domains) || !validateStringArray(persona.knowledge.limitations) ||
    persona.horizon !== horizonFromCutoff(persona.knowledge.cutoff) ||
    !Array.isArray(persona.behaviorLabels) || persona.behaviorLabels.length !== expectedLabels.length ||
    !persona.behaviorLabels.every((label, index) => label === expectedLabels[index])) {
    throw new TypeError("Invalid safe details persona");
  }
  return Object.freeze({
    name: persona.name,
    status: "Historical candidate · draft",
    summary: persona.summary,
    setting: persona.identity.setting,
    cutoff: persona.knowledge.cutoff,
    catalogFacts: Object.freeze([
      "Candidate pack includes curator-only PROVENANCE.md and SOURCES.md.",
      "Independent historical-fidelity/content-boundary review remains outstanding.",
      "Independent provenance/rights review remains outstanding.",
      "No Official Catalog Manifest entry exists.",
    ]),
    roomStrengths: Object.freeze(persona.knowledge.domains.slice(0, 3)),
    productiveContrast: Object.freeze([...persona.behaviorLabels]),
    contrastContext: "These typed behavior labels may contrast with selected perspectives in the room.",
    portrayalCautions: Object.freeze([...persona.knowledge.limitations]),
    notice: persona.educationalNotice,
  });
}

export function startBrowserApp() {
  const byId = (id) => document.getElementById(id);
  const elements = {
    actionStatus: byId("action-status"), backToGallery: byId("back-to-gallery"), builderError: byId("builder-error"),
    builderHeading: byId("cast-builder-heading"), builderSeats: byId("builder-seats"), builderStatus: byId("builder-status"),
    cancelSetup: byId("cancel-cast-setup"), castList: byId("cast-list"), composerNote: byId("composer-note"),
    connection: document.querySelector(".connection"), connectionStatus: byId("connection-status"),
    details: byId("persona-details"), detailsAdd: byId("details-add"), detailsContent: byId("persona-details-content"),
    detailsTitle: byId("persona-details-title"), domain: byId("domain-filter"), emptyTranscript: byId("empty-transcript"),
    filters: byId("gallery-filters"), form: byId("message-form"), galleryHeading: byId("gallery-heading"),
    galleryResults: byId("gallery-results"), grid: byId("persona-grid"), horizon: byId("horizon-filter"),
    identityRoster: byId("room-identity-roster"), liveView: byId("live-view"), messageText: byId("message-text"), mobileAction: byId("mobile-room-action"),
    openSetup: byId("open-cast-setup"), pauseResume: byId("pause-resume"), search: byId("persona-search"),
    sendMessage: byId("send-message"), setupView: byId("cast-setup-view"), startRoom: byId("start-historical-room"),
    stopDialog: byId("stop-dialog"), stopRoom: byId("stop-room"), skipLink: byId("skip-link"), transcript: byId("transcript"),
    transcriptPanel: byId("transcript-panel"), viewRoom: byId("view-room"), wantsResponse: byId("wants-response"),
  };
  let csrfToken = "";
  let humanEmoji = HUMAN_EMOJIS[0];
  let room = null;
  let catalog = null;
  let catalogError = "";
  let selection = createSelectionState();
  const channelHolder = createRoomChannelHolder();
  const lifecycle = bindRoomChannelLifecycle(channelHolder, globalThis);
  let roomStatusUnknown = false;
  let detailsSlug = null;
  let detailsTrigger = null;
  const pending = new Set();

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function setActionStatus(message, tone = "neutral") {
    elements.actionStatus.textContent = message;
    elements.actionStatus.dataset.tone = tone;
  }

  function setConnection(state) {
    const copy = { connected: "Live connection", "catching-up": "Catching up…", reconnecting: "Reconnecting…", offline: "Room connection closed" };
    elements.connection.dataset.connection = state;
    elements.connectionStatus.textContent = copy[state] ?? "Opening the local room…";
  }

  function catalogPersona(slug) { return catalog?.find((persona) => persona.slug === slug) ?? null; }
  function participantName(participantId) { return room?.participants.find(({ id }) => id === participantId)?.displayName ?? "Cast member"; }
  function participantIdentity(participantId) {
    const participant = room?.participants.find(({ id }) => id === participantId) ?? null;
    return participant?.kind === "human" ? { ...participant, emoji: humanEmoji } : participant;
  }

  function renderControls() {
    if (room === null) return;
    const availability = controlAvailability(room.status, pending);
    const isPaused = room.status === "paused";
    elements.messageText.disabled = !availability.canCompose;
    elements.wantsResponse.disabled = !availability.canCompose;
    elements.sendMessage.disabled = !availability.canCompose;
    elements.pauseResume.disabled = !availability.canPauseResume;
    elements.stopRoom.disabled = !availability.canStop;
    elements.openSetup.disabled = pending.size !== 0;
    elements.openSetup.textContent = room.status === "stopped" ? "Start a new historical room" :
      room.participants.some(({ kind }) => kind === "persona") ? "Change cast" : "Build historical room";
    elements.pauseResume.textContent = isPaused ? "Resume room" : "Pause room";
    elements.composerNote.textContent = room.status === "stopped" ? "This room has stopped permanently. The transcript remains available." :
      isPaused ? "Resume the room before sending another message." : pending.has("message") ? "The room is considering this cue." :
        "Messages are available while the room is active.";
    for (const button of elements.castList.querySelectorAll("[data-persona-control]")) {
      button.disabled = !controlAvailability(room.status, pending, false, button.dataset.personaControl).canToggleMute;
    }
    for (const select of elements.castList.querySelectorAll("[data-human-emoji]")) select.disabled = pending.size !== 0;
    if (roomStatusUnknown) {
      elements.messageText.disabled = true; elements.wantsResponse.disabled = true; elements.sendMessage.disabled = true;
      elements.pauseResume.disabled = true; elements.stopRoom.disabled = true; elements.openSetup.disabled = true;
      for (const button of elements.castList.querySelectorAll("[data-persona-control]")) button.disabled = true;
      for (const select of elements.castList.querySelectorAll("[data-human-emoji]")) select.disabled = true;
    }
  }

  function renderRoom(nextRoom) {
    validateRoomDto(nextRoom);
    room = nextRoom;
    byId("room-status").textContent = STATUS_LABELS[room.status];
    elements.liveView.dataset.roomStatus = room.status;
    elements.castList.replaceChildren();
    elements.identityRoster.replaceChildren();
    for (const [index, participant] of room.participants.entries()) {
      const item = node("li", `cast-member${participant.muted ? " is-muted" : ""}`);
      const portrait = renderCharacterPortrait(participant.kind === "persona" ? participant.personaSlug : null, participant.displayName, { className: "portrait-roster", width: 96, height: 96, eager: true, fallbackText: participant.kind === "human" ? humanEmoji : undefined });
      const identity = node("div");
      identity.append(node("strong", "persona-name", participant.displayName));
      const presentation = participant.kind === "persona" ? activePersonaPresentation(participant.personaSlug, catalog) : null;
      identity.append(node("p", "persona-role", participant.kind === "human" ? "Human participant" : presentation.role));
      if (participant.kind === "persona") {
        identity.append(node("p", "persona-temperament", presentation.temperament));
        identity.append(node("p", "persona-state", participant.muted ? "Muted" : "Ready"));
      }
      item.append(portrait, identity);
      if (participant.kind === "persona") {
        const button = node("button", "button mute-toggle", participant.muted ? "Unmute" : "Mute");
        button.type = "button";
        button.dataset.personaControl = participant.id;
        button.dataset.action = participant.muted ? "unmute" : "mute";
        button.setAttribute("aria-label", `${participant.muted ? "Unmute" : "Mute"} ${participant.displayName}`);
        item.append(button);
      } else {
        const label = node("label", "human-emoji-picker");
        label.append(node("span", "", "Your emoji"));
        const select = node("select");
        select.setAttribute("aria-label", "Choose your emoji");
        select.dataset.humanEmoji = "";
        for (const emoji of HUMAN_EMOJIS) {
          const option = node("option", "", emoji);
          option.value = emoji;
          option.selected = emoji === humanEmoji;
          select.append(option);
        }
        label.append(select);
        item.append(label);
      }
      elements.castList.append(item);
      if (participant.kind === "persona") {
        const summary = node("li", "identity-person");
        const summaryPortrait = renderCharacterPortrait(participant.personaSlug, participant.displayName, { className: "portrait-identity", width: 80, height: 80, eager: true });
        const summaryText = node("span", "identity-person-copy");
        summaryText.append(node("strong", "", participant.displayName), node("span", "", presentation.role));
        summary.append(summaryPortrait, summaryText);
        elements.identityRoster.append(summary);
      }
    }
    elements.castList.setAttribute("aria-busy", "false");
    renderControls();
  }

  function renderEvent(record) {
    elements.transcript.append(renderTranscriptEvent(record, participantName, document, participantIdentity));
    elements.emptyTranscript.hidden = true;
    elements.transcriptPanel.scrollTop = elements.transcriptPanel.scrollHeight;
  }

  function clearSession() {
    elements.transcript.replaceChildren();
    elements.emptyTranscript.hidden = false;
    elements.messageText.value = "";
    setActionStatus("");
  }

  async function fetchReplay(after, operation) {
    const replay = await getJson(API_PATHS.events(after), operation?.signal);
    if (!plainRecord(replay) || !Array.isArray(replay.events)) throw new RequestFailure("invalid_response");
    return replay.events;
  }

  function createChannel(sessionId) {
    const commit = createSessionCommit(sessionId, () => room?.sessionId, renderEvent);
    return createRoomEventChannel({
      commit,
      fetchCatchUp: fetchReplay,
      connect(after, handlers) {
        const eventSource = new EventSource(API_PATHS.stream(after));
        eventSource.addEventListener("open", handlers.onOpen);
        eventSource.addEventListener("error", handlers.onError);
        eventSource.addEventListener("room-event", (message) => {
          try { handlers.onEvent(JSON.parse(message.data)); } catch { handlers.onError(); }
        });
        return { close: () => eventSource.close() };
      },
      onConnectionChange: setConnection,
    });
  }

  function markGeneratedSilence(result) {
    if (result?.outcome !== "silence" || !Number.isSafeInteger(result.directorEventSequence)) return;
    const item = elements.transcript.querySelector(`[data-sequence="${result.directorEventSequence}"]`);
    if (item === null) return;
    item.className = "transcript-item event-silence";
    item.querySelector(".event-speaker").textContent = "Silence";
    item.querySelector(".event-text").textContent = "The cast member chose not to speak.";
    item.querySelector(".event-reason").textContent = "The cue ended in a deliberate quiet beat.";
  }

  async function refreshRoom() { renderRoom(await getJson(API_PATHS.room)); }

  async function mutate(key, path, body, progressMessage) {
    if (!reserveMutation(pending, key)) return null;
    renderControls(); renderBuilder(); setActionStatus(progressMessage);
    try {
      const result = await postJson(path, body, csrfToken);
      await channelHolder.catchUp();
      await refreshRoom();
      setActionStatus("");
      return result;
    } catch (error) {
      try { await refreshRoom(); } catch { /* Keep the last validated room. */ }
      setActionStatus(userMessage(error), "error");
      return null;
    } finally { pending.delete(key); renderControls(); renderBuilder(); }
  }

  function fillSelect(select, values) {
    for (const value of values) {
      const option = node("option", "", value);
      option.value = value;
      select.append(option);
    }
  }

  function initializeFilters() {
    const options = catalogFilterOptions(catalog);
    elements.horizon.length = 1;
    elements.domain.length = 1;
    fillSelect(elements.horizon, options.horizons);
    fillSelect(elements.domain, options.domains);
  }

  function currentFilters() { return { query: elements.search.value, horizon: elements.horizon.value, domain: elements.domain.value }; }

  function renderGalleryState(title, copy, withRetry = false) {
    const state = node("div", "gallery-state");
    state.append(node("strong", "", title), node("span", "", copy));
    if (withRetry) {
      const retry = node("button", "button button-secondary", "Try catalog again"); retry.type = "button";
      retry.addEventListener("click", () => void loadCatalog(true)); state.append(retry);
    }
    elements.grid.replaceChildren(state);
  }

  function renderCard(persona) {
    const article = node("article", "persona-card");
    article.setAttribute("aria-labelledby", `persona-${persona.slug}`);
    const top = node("div", "persona-card-top");
    const portrait = renderCharacterPortrait(persona.slug, persona.name, { className: "portrait-card", descriptive: true, width: 420, height: 525 });
    top.append(portrait, node("span", "candidate-badge", "Candidate · draft"));
    const title = node("h3", "", persona.name); title.id = `persona-${persona.slug}`;
    article.append(top, title, node("p", "card-setting", `${persona.identity.setting} · cutoff ${persona.knowledge.cutoff}`), node("p", "card-summary", persona.summary));
    const domains = node("ul", "tag-list");
    persona.knowledge.domains.slice(0, 3).forEach((domain) => domains.append(node("li", "", domain)));
    const temperament = node("ul", "temperament-list");
    persona.behaviorLabels.slice(0, 3).forEach((label) => temperament.append(node("li", "", label)));
    const actions = node("div", "card-actions");
    const details = node("button", "button button-secondary", "Details"); details.type = "button";
    details.dataset.detailsSlug = persona.slug;
    const selected = selection.slugs.includes(persona.slug);
    const add = node("button", "button button-primary", selected ? "Remove" : "Add"); add.type = "button";
    add.dataset.selectionSlug = persona.slug; add.dataset.action = selected ? "remove" : "add";
    add.disabled = !selected && selection.slugs.length >= 3;
    add.setAttribute("aria-label", `${selected ? "Remove" : "Add"} ${persona.name} ${selected ? "from" : "to"} room`);
    actions.append(details, add); article.append(domains, temperament, actions);
    return article;
  }

  function renderGallery() {
    if (catalog === null) {
      elements.galleryResults.textContent = catalogError ? "Catalog unavailable" : "Loading 12 candidates…";
      elements.grid.setAttribute("aria-busy", String(!catalogError));
      renderGalleryState(catalogError ? "Historical catalog unavailable" : "Loading historical candidates…", catalogError || "The safe local catalog is being checked.", Boolean(catalogError));
      return;
    }
    const matches = filterCatalog(catalog, currentFilters());
    elements.galleryResults.textContent = `${matches.length} of ${catalog.length} candidates shown`;
    elements.grid.setAttribute("aria-busy", "false");
    if (matches.length === 0) {
      renderGalleryState("No candidates match", "Clear or broaden the search and filters.");
      const clear = node("button", "button button-secondary", "Clear filters"); clear.type = "button";
      clear.addEventListener("click", clearFilters); elements.grid.firstElementChild.append(clear); return;
    }
    elements.grid.replaceChildren(...matches.map(renderCard));
  }

  function renderBuilder(focusTarget = null) {
    elements.builderSeats.replaceChildren();
    for (let index = 0; index < 3; index += 1) {
      const slug = selection.slugs[index];
      const seat = node("li", slug ? "builder-seat" : "builder-seat open-seat");
      if (!slug) { seat.textContent = `${index + 1}. Open persona seat`; elements.builderSeats.append(seat); continue; }
      const persona = catalogPersona(slug);
      const seatIdentity = node("span", "seat-identity");
      seatIdentity.append(node("span", "seat-name", persona?.name ?? slug), node("span", "seat-role", persona ? `${persona.knowledge.domains[0]} · ${persona.horizon}` : "Custom persona"));
      seat.append(renderCharacterPortrait(slug, persona?.name ?? slug, { className: "portrait-seat", width: 64, height: 64 }), seatIdentity);
      const remove = node("button", "button seat-remove", "Remove"); remove.type = "button"; remove.dataset.removeSlug = slug;
      remove.setAttribute("aria-label", `Remove ${persona?.name ?? slug} from seat ${index + 1}`); seat.append(remove); elements.builderSeats.append(seat);
    }
    const count = selection.slugs.length;
    elements.builderStatus.textContent = count === 0 ? "0 of 3 persona seats filled. Choose at least one." :
      count === 3 ? "3 of 3 persona seats filled. Cast is full and ready." : `${count} of 3 persona seats filled. You may start now or add ${3 - count} more.`;
    elements.startRoom.disabled = roomStatusUnknown || count === 0 || pending.size !== 0 || catalog === null;
    elements.mobileAction.hidden = count === 0 || elements.setupView.hidden;
    elements.viewRoom.textContent = `View room (${count} of 3)`;
    document.body.classList.toggle("has-mobile-room-action", count > 0 && !elements.setupView.hidden);
    if (focusTarget?.kind === "remove") elements.builderSeats.querySelector(`[data-remove-slug="${focusTarget.slug}"]`)?.focus();
    if (focusTarget?.kind === "builder") elements.builderHeading.focus();
  }

  function changeSelection(slug, action, focusAfterRemove = true) {
    try {
      if (action === "add") selection = addSelection(selection, slug);
      else {
        const removed = removeSelection(selection, slug); selection = removed.state;
        renderGallery(); renderBuilder(focusAfterRemove ? removed.focus : null); return;
      }
      elements.builderError.textContent = ""; renderGallery(); renderBuilder();
    } catch (error) { elements.builderError.textContent = error instanceof Error ? error.message : "The cast could not be changed."; }
  }

  function clearFilters() { elements.search.value = ""; elements.horizon.value = "all"; elements.domain.value = "all"; renderGallery(); elements.search.focus(); }

  function appendDetailSection(parent, heading, values) {
    parent.append(node("h3", "detail-subheading", heading));
    const list = node("ul", "detail-list"); values.forEach((value) => list.append(node("li", "", value))); parent.append(list);
  }

  function openDetails(slug, trigger) {
    const persona = catalogPersona(slug); if (persona === null) return;
    const details = safeDetailsContent(persona); detailsSlug = slug; detailsTrigger = trigger;
    elements.detailsTitle.textContent = details.name;
    const content = document.createDocumentFragment();
    const detailIdentity = node("div", "detail-identity");
    detailIdentity.append(renderCharacterPortrait(persona.slug, persona.name, { className: "portrait-detail", descriptive: true, width: 320, height: 400, eager: true }), node("p", "detail-summary", details.summary));
    content.append(node("p", "candidate-badge detail-badge", details.status), detailIdentity);
    const facts = node("dl", "detail-facts");
    for (const [term, description] of [["Setting", details.setting], ["Knowledge cutoff", details.cutoff]]) {
      facts.append(node("dt", "", term), node("dd", "", description));
    }
    content.append(facts);
    appendDetailSection(content, "Catalog status", details.catalogFacts);
    appendDetailSection(content, "Room strengths", details.roomStrengths);
    content.append(node("h3", "detail-subheading", "Productive contrast"), node("p", "detail-context", details.contrastContext));
    const contrast = node("ul", "detail-list");
    details.productiveContrast.forEach((value) => contrast.append(node("li", "", value)));
    content.append(contrast);
    appendDetailSection(content, "Portrayal cautions", details.portrayalCautions);
    const notice = node("p", "educational-notice"); const lead = node("strong", "", "Educational creative interpretation.");
    notice.append(lead, document.createTextNode(details.notice.slice("Educational creative interpretation.".length))); content.append(notice);
    elements.detailsContent.replaceChildren(content);
    const selected = selection.slugs.includes(slug); elements.detailsAdd.textContent = selected ? "Remove from room" : "Add to room";
    elements.detailsAdd.disabled = !selected && selection.slugs.length >= 3;
    elements.details.showModal();
  }

  function closeDetails() { elements.details.close(); }

  function showSetup() {
    if (room === null || pending.size !== 0) return;
    selection = catalog === null ? createSelectionState() : historicalSelectionFromRoom(room, catalog);
    elements.liveView.hidden = true; elements.setupView.hidden = false; elements.builderError.textContent = "";
    elements.skipLink.href = "#gallery-heading"; elements.skipLink.textContent = "Skip to historical candidates";
    renderGallery(); renderBuilder(); elements.galleryHeading.focus();
  }

  function showLive(focus = true) {
    elements.setupView.hidden = true; elements.liveView.hidden = false; elements.mobileAction.hidden = true;
    elements.skipLink.href = "#message-text"; elements.skipLink.textContent = "Skip to message composer";
    document.body.classList.remove("has-mobile-room-action"); if (focus) elements.openSetup.focus();
  }

  async function loadCatalog(force = false) {
    if (catalog !== null && !force) return;
    catalog = null; catalogError = ""; renderGallery();
    try { catalog = validateCatalogDto(await getJson(API_PATHS.catalog)); initializeFilters(); renderRoom(room); }
    catch { catalogError = "The local catalog response failed its safety checks. Your current room is unchanged."; }
    renderGallery(); renderBuilder();
  }

  async function startHistoricalRoom() {
    if (roomStatusUnknown || selection.slugs.length === 0 || room === null || catalog === null || channelHolder.current === null || !reserveCastStart(pending)) return;
    const requestId = createRequestId("cast"); const personaSlugs = [...selection.slugs]; const oldSessionId = room.sessionId;
    elements.builderError.textContent = "Starting the new room…"; renderBuilder(); renderControls();
    try {
      const response = await postJson(API_PATHS.cast, { requestId, personaSlugs }, csrfToken);
      const outcome = reconcileHistoricalRoomAttempt({ response, requestId, personaSlugs, oldSessionId });
      if (outcome.kind !== "committed") throw new RequestFailure("invalid_response");
      await transitionRoomSession({
        room: outcome.room, oldSessionId, lifecycle,
        clearSession: () => { if (!lifecycle.isDisposed) clearSession(); },
        renderRoom: (nextRoom) => { if (!lifecycle.isDisposed) renderRoom(nextRoom); },
        createChannel(sessionId) { return createChannel(sessionId); },
      });
      roomStatusUnknown = false;
      if (!lifecycle.isDisposed) elements.builderError.textContent = "";
      if (lifecycle.isActive) { showLive(false); elements.messageText.focus(); }
    } catch (error) {
      let authoritativeRoom;
      try { authoritativeRoom = await getJson(API_PATHS.room); } catch { /* Status remains unknown. */ }
      const outcome = reconcileHistoricalRoomAttempt({ authoritativeRoom, requestId, personaSlugs, oldSessionId });
      if (outcome.kind === "committed") {
        try {
          if (room?.sessionId !== outcome.room.sessionId) {
            await transitionRoomSession({
              room: outcome.room, oldSessionId, lifecycle,
              clearSession: () => { if (!lifecycle.isDisposed) clearSession(); },
              renderRoom: (nextRoom) => { if (!lifecycle.isDisposed) renderRoom(nextRoom); },
              createChannel(sessionId) { return createChannel(sessionId); },
            });
          } else {
            await lifecycle.startIfActive();
          }
          if (!lifecycle.isDisposed) {
            roomStatusUnknown = false;
            elements.builderError.textContent = "";
            setActionStatus(outcome.requestedCast ?
              "The new room was committed. Its latest confirmed state was recovered." :
              "The room changed concurrently. Its latest confirmed cast is now shown.");
          }
          if (lifecycle.isActive) { showLive(false); elements.messageText.focus(); }
        } catch {
          roomStatusUnknown = true; lifecycle.suspend();
          if (!lifecycle.isDisposed) elements.builderError.textContent = "The room status is unknown. Reload this page before continuing.";
        }
      } else if (outcome.kind === "unchanged") {
        if (!lifecycle.isDisposed) {
          renderRoom(outcome.room);
          elements.builderError.textContent = `${userMessage(error)} The new room was not started; your selection is still available.`;
        }
      } else if (!lifecycle.isDisposed) {
        roomStatusUnknown = true; lifecycle.suspend();
        elements.builderError.textContent = "The room status is unknown. Reload this page before continuing.";
      }
    } finally {
      pending.delete("cast");
      if (!lifecycle.isDisposed) { renderBuilder(); renderControls(); }
    }
  }

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault(); const text = elements.messageText.value;
    if (!canSubmitMessage(room?.status, pending, text, elements.sendMessage.disabled)) return;
    const result = await mutate("message", API_PATHS.messages, { requestId: createRequestId("message"), text, wantsResponse: elements.wantsResponse.checked }, "The director is considering the cue…");
    if (result !== null) { elements.messageText.value = ""; markGeneratedSilence(result); elements.messageText.focus(); }
  });
  elements.pauseResume.addEventListener("click", async () => {
    if (room === null || room.status === "stopped" || pending.size !== 0) return;
    const action = room.status === "paused" ? "resume" : "pause";
    await mutate("room", API_PATHS.roomControl(action), { requestId: createRequestId(action) }, action === "pause" ? "Pausing the room…" : "Resuming the room…");
  });
  elements.stopRoom.addEventListener("click", () => { if (room?.status !== "stopped" && pending.size === 0) openStopConfirmation(elements.stopDialog); });
  elements.stopDialog.addEventListener("close", async () => {
    if (elements.stopDialog.returnValue !== "confirm" || room?.status === "stopped" || pending.size !== 0) return;
    await mutate("room", API_PATHS.roomControl("stop"), { requestId: createRequestId("stop") }, "Stopping the room…");
  });
  elements.castList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-persona-control]"); if (button === null || button.disabled || room === null || pending.size !== 0) return;
    const personaId = button.dataset.personaControl; const action = button.dataset.action;
    if (!PERSONA_ID.test(personaId) || !PERSONA_ACTIONS.has(action)) return;
    await mutate(`persona:${personaId}`, API_PATHS.personaControl(personaId, action), { requestId: createRequestId(`${action}-${personaId}`) }, action === "mute" ? "Muting cast member…" : "Returning cast member to the room…");
  });
  elements.castList.addEventListener("change", async (event) => {
    const select = event.target.closest("[data-human-emoji]");
    if (select === null || !HUMAN_EMOJIS.includes(select.value) || pending.size !== 0) return;
    pending.add("human-profile"); renderControls();
    try {
      const profile = validateHumanProfileDto(await postJson(API_PATHS.humanProfile, { emoji: select.value }, csrfToken));
      humanEmoji = profile.emoji;
      renderRoom(room);
      setActionStatus("Your emoji was saved on this device.");
    } catch (error) {
      setActionStatus(userMessage(error), "error");
      renderRoom(room);
    } finally { pending.delete("human-profile"); renderControls(); }
  });
  elements.openSetup.addEventListener("click", () => { if (!elements.openSetup.disabled && pending.size === 0) showSetup(); }); elements.cancelSetup.addEventListener("click", () => showLive());
  elements.filters.addEventListener("submit", (event) => event.preventDefault());
  elements.filters.addEventListener("input", renderGallery); elements.filters.addEventListener("change", renderGallery);
  elements.grid.addEventListener("click", (event) => {
    const details = event.target.closest("[data-details-slug]"); if (details) { openDetails(details.dataset.detailsSlug, details); return; }
    const control = event.target.closest("[data-selection-slug]"); if (control && !control.disabled) changeSelection(control.dataset.selectionSlug, control.dataset.action);
  });
  elements.builderSeats.addEventListener("click", (event) => { const remove = event.target.closest("[data-remove-slug]"); if (remove) changeSelection(remove.dataset.removeSlug, "remove"); });
  elements.startRoom.addEventListener("click", () => void startHistoricalRoom());
  for (const close of document.querySelectorAll(".details-close")) close.addEventListener("click", () => closeDetails());
  elements.details.addEventListener("click", (event) => { if (event.target === elements.details) closeDetails(); });
  elements.details.addEventListener("close", () => { const trigger = detailsTrigger; detailsTrigger = null; detailsSlug = null; restoreDialogTriggerFocus(trigger); });
  elements.detailsAdd.addEventListener("click", () => {
    if (detailsSlug === null || elements.detailsAdd.disabled) return;
    const slug = detailsSlug; const selected = selection.slugs.includes(slug); detailsTrigger = null; elements.details.close(); changeSelection(slug, selected ? "remove" : "add", false);
    if (!selected) elements.builderSeats.querySelector(`[data-remove-slug="${slug}"]`)?.focus(); else elements.builderHeading.focus();
  });
  elements.viewRoom.addEventListener("click", () => { elements.builderHeading.scrollIntoView({ block: "start" }); elements.builderHeading.focus({ preventScroll: true }); });
  elements.backToGallery.addEventListener("click", (event) => { event.preventDefault(); elements.galleryHeading.scrollIntoView({ block: "start" }); elements.galleryHeading.focus({ preventScroll: true }); });
  void (async () => {
    try {
      await initializeRoomBeforeCatalog({
        async bootstrapRoom() {
          const bootstrap = await getJson(API_PATHS.bootstrap);
          validateBootstrapDto(bootstrap);
          csrfToken = bootstrap.csrfToken;
          humanEmoji = validateHumanProfileDto(await getJson(API_PATHS.humanProfile)).emoji;
          const nextRoom = await getJson(API_PATHS.room);
          renderRoom(nextRoom);
          lifecycle.replace(createChannel(room.sessionId));
          await lifecycle.activate();
          renderGallery(); renderBuilder();
        },
        loadCatalog,
      });
    } catch (error) {
      setConnection("offline"); setActionStatus(userMessage(error), "error");
    }
  })();
}

if (typeof document !== "undefined") startBrowserApp();
