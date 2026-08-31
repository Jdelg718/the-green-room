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
  return Object.freeze({
    canCompose: status === "active" && !pending.has("message"),
    canPauseResume: !stopped && !pending.has("room"),
    canStop: !stopped && !pending.has("room"),
    canToggleMute: !stopped && !pending.has("room") && !pending.has(`persona:${personaId ?? ""}`),
  });
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

export function bindRoomChannelLifecycle(channel, target = globalThis) {
  let disposed = false;
  let ready = false;
  let pageActive = true;

  function removeListeners() {
    if (disposed) return;
    disposed = true;
    target.removeEventListener("pagehide", onPageHide);
    target.removeEventListener("pageshow", onPageShow);
  }

  function onPageHide(event) {
    pageActive = false;
    channel.stop();
    if (!event.persisted) removeListeners();
  }

  function onPageShow(event) {
    if (!event.persisted || disposed) return;
    pageActive = true;
    if (ready) void channel.start();
  }

  target.addEventListener("pagehide", onPageHide);
  target.addEventListener("pageshow", onPageShow);

  return Object.freeze({
    async activate() {
      ready = true;
      if (pageActive && !disposed) await channel.start();
    },
    dispose() {
      if (disposed) return;
      removeListeners();
      channel.stop();
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

export function startBrowserApp() {
  const elements = {
    actionStatus: document.querySelector("#action-status"), castList: document.querySelector("#cast-list"),
    composerNote: document.querySelector("#composer-note"), connection: document.querySelector(".connection"),
    connectionStatus: document.querySelector("#connection-status"), emptyTranscript: document.querySelector("#empty-transcript"),
    form: document.querySelector("#message-form"), messageText: document.querySelector("#message-text"),
    pauseResume: document.querySelector("#pause-resume"), roomShell: document.querySelector(".room-shell"),
    roomStatus: document.querySelector("#room-status"), sendMessage: document.querySelector("#send-message"),
    stopDialog: document.querySelector("#stop-dialog"), stopRoom: document.querySelector("#stop-room"),
    transcript: document.querySelector("#transcript"), transcriptPanel: document.querySelector("#transcript-panel"),
    wantsResponse: document.querySelector("#wants-response"),
  };
  let csrfToken = "";
  let room = null;
  const pending = new Set();

  function setActionStatus(message, tone = "neutral") {
    elements.actionStatus.textContent = message;
    elements.actionStatus.dataset.tone = tone;
  }

  function setConnection(state) {
    const copy = { connected: "Live connection", "catching-up": "Catching up…", reconnecting: "Reconnecting…", offline: "Room connection closed" };
    elements.connection.dataset.connection = state;
    elements.connectionStatus.textContent = copy[state] ?? "Opening the local room…";
  }

  function participantName(participantId) {
    return room?.participants.find(({ id }) => id === participantId)?.displayName ?? "Cast member";
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
    elements.pauseResume.textContent = isPaused ? "Resume room" : "Pause room";
    elements.composerNote.textContent = room.status === "stopped"
      ? "This room has stopped permanently. The transcript remains available."
      : isPaused ? "Resume the room before sending another message."
        : pending.has("message") ? "The room is considering this cue."
          : "Messages are available while the room is active.";
    for (const button of elements.castList.querySelectorAll("[data-persona-control]")) {
      const personaId = button.dataset.personaControl;
      button.disabled = !controlAvailability(room.status, pending, false, personaId).canToggleMute;
    }
  }

  function renderRoom(nextRoom) {
    if (nextRoom === null || typeof nextRoom !== "object" ||
      !["active", "paused", "stopped"].includes(nextRoom.status) || !Array.isArray(nextRoom.participants)) {
      throw new RequestFailure("invalid_response");
    }
    const participantIds = new Set();
    if (!nextRoom.participants.every((participant) => participant !== null &&
      typeof participant === "object" && typeof participant.id === "string" &&
      typeof participant.displayName === "string" && (participant.kind === "human" || participant.kind === "persona") &&
      typeof participant.muted === "boolean" && (participant.kind !== "persona" || PERSONA_ID.test(participant.id)) &&
      !participantIds.has(participant.id) && participantIds.add(participant.id))) {
      throw new RequestFailure("invalid_response");
    }
    room = nextRoom;
    elements.roomStatus.textContent = STATUS_LABELS[room.status];
    elements.roomShell.dataset.roomStatus = room.status;
    elements.castList.replaceChildren();
    for (const [index, participant] of room.participants.entries()) {
      const item = document.createElement("li");
      item.className = `cast-member${participant.muted ? " is-muted" : ""}`;
      const number = document.createElement("span");
      number.className = "cast-number";
      number.setAttribute("aria-hidden", "true");
      number.textContent = String(index + 1).padStart(2, "0");
      const identity = document.createElement("div");
      const name = document.createElement("strong");
      name.className = "persona-name";
      name.textContent = participant.displayName;
      const role = document.createElement("p");
      role.className = "persona-role";
      role.textContent = participant.kind === "human" ? "Human participant" : "Persona";
      identity.append(name, role);
      item.append(number, identity);
      if (participant.kind === "persona") {
        const state = document.createElement("p");
        state.className = "persona-state";
        state.textContent = participant.muted ? "Muted" : "Ready";
        identity.append(state);
        const button = document.createElement("button");
        button.className = "button mute-toggle";
        button.type = "button";
        button.dataset.personaControl = participant.id;
        button.dataset.action = participant.muted ? "unmute" : "mute";
        button.textContent = participant.muted ? "Unmute" : "Mute";
        button.setAttribute("aria-label", `${participant.muted ? "Unmute" : "Mute"} ${participant.displayName}`);
        item.append(button);
      }
      elements.castList.append(item);
    }
    elements.castList.setAttribute("aria-busy", "false");
    renderControls();
  }

  function safeText(value) { return typeof value === "string" ? value : ""; }

  function renderEvent(record) {
    const event = record.event;
    const item = document.createElement("li");
    item.className = "transcript-item";
    item.dataset.sequence = String(record.sequence);
    const sequence = document.createElement("span");
    sequence.className = "event-sequence";
    sequence.textContent = `#${String(record.sequence).padStart(3, "0")}`;
    const body = document.createElement("div");
    body.className = "event-body";
    const speaker = document.createElement("h3");
    speaker.className = "event-speaker";
    const text = document.createElement("p");
    text.className = "event-text";
    body.append(speaker, text);
    if (event.type === "human_message") {
      item.classList.add("event-human");
      speaker.textContent = "You";
      text.textContent = safeText(event.text);
    } else if (event.type === "persona_message") {
      item.classList.add("event-persona");
      speaker.textContent = participantName(event.participantId);
      text.textContent = safeText(event.text);
    } else if (event.type === "director_decision") {
      const reason = safeText(event.reason);
      const reasonCopy = document.createElement("p");
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
    item.prepend(sequence);
    elements.transcript.append(item);
    elements.emptyTranscript.hidden = true;
    elements.transcriptPanel.scrollTop = elements.transcriptPanel.scrollHeight;
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

  async function fetchReplay(after, operation) {
    const replay = await getJson(API_PATHS.events(after), operation?.signal);
    if (replay === null || typeof replay !== "object" || !Array.isArray(replay.events)) {
      throw new RequestFailure("invalid_response");
    }
    return replay.events;
  }

  const channel = createRoomEventChannel({
    commit: renderEvent,
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
  const lifecycle = bindRoomChannelLifecycle(channel, globalThis);

  async function refreshRoom() { renderRoom(await getJson(API_PATHS.room)); }

  async function mutate(key, path, body, progressMessage) {
    pending.add(key);
    renderControls();
    setActionStatus(progressMessage);
    try {
      const result = await postJson(path, body, csrfToken);
      await channel.catchUp();
      await refreshRoom();
      setActionStatus("");
      return result;
    } catch (error) {
      try { await refreshRoom(); } catch { /* Retain the last known safe room state. */ }
      setActionStatus(userMessage(error), "error");
      return null;
    } finally {
      pending.delete(key);
      renderControls();
    }
  }

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = elements.messageText.value;
    if (room?.status !== "active" || text.trim().length === 0 || pending.has("message")) return;
    const result = await mutate("message", API_PATHS.messages, {
      requestId: createRequestId("message"), text, wantsResponse: elements.wantsResponse.checked,
    }, "The director is considering the cue…");
    if (result !== null) {
      elements.messageText.value = "";
      markGeneratedSilence(result);
      elements.messageText.focus();
    }
  });

  elements.pauseResume.addEventListener("click", async () => {
    if (room === null || room.status === "stopped" || pending.has("room")) return;
    const action = room.status === "paused" ? "resume" : "pause";
    await mutate("room", API_PATHS.roomControl(action), { requestId: createRequestId(action) },
      action === "pause" ? "Pausing the room…" : "Resuming the room…");
  });

  elements.stopRoom.addEventListener("click", () => {
    if (room?.status !== "stopped" && !pending.has("room")) openStopConfirmation(elements.stopDialog);
  });
  elements.stopDialog.addEventListener("close", async () => {
    if (elements.stopDialog.returnValue !== "confirm" || room?.status === "stopped") return;
    await mutate("room", API_PATHS.roomControl("stop"), { requestId: createRequestId("stop") }, "Stopping the room…");
  });

  elements.castList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-persona-control]");
    if (button === null || button.disabled || room === null) return;
    const personaId = button.dataset.personaControl;
    const action = button.dataset.action;
    if (!PERSONA_ID.test(personaId) || !PERSONA_ACTIONS.has(action)) return;
    await mutate(`persona:${personaId}`, API_PATHS.personaControl(personaId, action),
      { requestId: createRequestId(`${action}-${personaId}`) },
      action === "mute" ? "Muting cast member…" : "Returning cast member to the room…");
  });

  void (async () => {
    try {
      const bootstrap = await getJson(API_PATHS.bootstrap);
      if (bootstrap === null || typeof bootstrap !== "object" || typeof bootstrap.csrfToken !== "string") {
        throw new RequestFailure("invalid_response");
      }
      csrfToken = bootstrap.csrfToken;
      await refreshRoom();
      await lifecycle.activate();
    } catch (error) {
      setConnection("offline");
      setActionStatus(userMessage(error), "error");
    }
  })();
}

if (typeof document !== "undefined") startBrowserApp();
