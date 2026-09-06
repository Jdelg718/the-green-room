const EVENT_PROOF = Symbol("trusted-director-event");
const ONE_EVENT_COOLDOWN = 1;
const DEFAULT_AUTONOMOUS_TURN_BUDGET = 10;
const DIRECTOR_SNAPSHOT_KEYS = Object.freeze([
  "acceptedHumanEventNumber",
  "autonomousTurns",
  "cancelled",
  "fallbackIndex",
  "lastSelectedAt",
  "maxAutonomousTurns",
  "seen",
  "version",
] as const);

export const DIRECTOR_LIMITS = Object.freeze({
  MAX_NAMESPACE_LENGTH: 128,
  MAX_EVENT_ID_LENGTH: 256,
  MAX_TRACKED_EVENT_IDENTITIES: 500,
} as const);

export const DIRECTOR_REASON = Object.freeze({
  SELECTED: "selected",
  DIRECTED: "directed",
  CANCELLED: "cancelled",
  UNVERIFIED_EVENT: "unverified_event",
  DUPLICATE: "duplicate",
  SELF_TRIGGER_BLOCKED: "self_trigger_blocked",
  BUDGET_EXHAUSTED: "budget_exhausted",
  DELIBERATE_SILENCE: "deliberate_silence",
  NO_PERSONA: "no_persona",
  NO_ELIGIBLE_PERSONA: "no_eligible_persona",
  COOLDOWN: "cooldown",
} as const);

export type DirectorReason =
  (typeof DIRECTOR_REASON)[keyof typeof DIRECTOR_REASON];

export interface DirectorDecision {
  readonly speaker: string | null;
  readonly reason: DirectorReason;
}

export interface DirectorEvent {
  readonly namespace: string;
  readonly eventId: string;
  readonly isHuman: boolean;
  readonly text: string;
  readonly wantsResponse: boolean;
}

export interface DirectorOptions {
  readonly maxAutonomousTurns?: number;
}

export interface DirectorSnapshot {
  readonly version: 1;
  readonly autonomousTurns: number;
  readonly acceptedHumanEventNumber: number;
  readonly fallbackIndex: number;
  readonly cancelled: boolean;
  readonly maxAutonomousTurns: number;
  readonly lastSelectedAt: readonly (readonly [personaId: string, eventNumber: number])[];
  readonly seen: readonly (readonly [namespace: string, eventId: string])[];
}

class VerifiedDirectorEvent implements DirectorEvent {
  readonly [EVENT_PROOF] = true;

  constructor(
    readonly namespace: string,
    readonly eventId: string,
    readonly isHuman: boolean,
    readonly text: string,
    readonly wantsResponse: boolean,
  ) {
    Object.freeze(this);
  }
}

function requireCanonicalIdentifier(
  value: string,
  field: string,
  maxLength?: number,
): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a canonical nonblank string`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new TypeError(`${field} must be at most ${maxLength} characters`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export class TrustedEventAdapter {
  readonly #namespace: string;

  constructor(namespace: string) {
    this.#namespace = requireCanonicalIdentifier(
      namespace,
      "namespace",
      DIRECTOR_LIMITS.MAX_NAMESPACE_LENGTH,
    );
  }

  humanEvent(eventId: string, text: string, wantsResponse = true): DirectorEvent {
    return this.#event(eventId, true, text, wantsResponse);
  }

  nonHumanEvent(eventId: string, text: string): DirectorEvent {
    return this.#event(eventId, false, text, true);
  }

  #event(
    eventId: string,
    isHuman: boolean,
    text: string,
    wantsResponse: boolean,
  ): DirectorEvent {
    return new VerifiedDirectorEvent(
      this.#namespace,
      requireCanonicalIdentifier(
        eventId,
        "eventId",
        DIRECTOR_LIMITS.MAX_EVENT_ID_LENGTH,
      ),
      isHuman,
      text,
      wantsResponse,
    );
  }
}

function decision(
  speaker: string | null,
  reason: DirectorReason,
): DirectorDecision {
  return Object.freeze({ speaker, reason });
}

export class Director {
  readonly #personas: readonly string[];
  readonly #personaSet: ReadonlySet<string>;
  readonly #muted = new Set<string>();
  readonly #lastSelectedAt = new Map<string, number>();
  readonly #seenByNamespace = new Map<string, Set<string>>();
  readonly #seenOrder: Array<readonly [namespace: string, eventId: string]> = [];
  readonly #maxAutonomousTurns: number;
  #autonomousTurns = 0;
  #acceptedHumanEventNumber = 0;
  #fallbackIndex = 0;
  #cancelled = false;

  constructor(
    personas: readonly string[],
    options: DirectorOptions = {},
    snapshot?: DirectorSnapshot,
  ) {
    const canonicalPersonas = personas.map((persona) =>
      requireCanonicalIdentifier(persona, "persona id"),
    );
    if (new Set(canonicalPersonas).size !== canonicalPersonas.length) {
      throw new TypeError("duplicate persona ids are not allowed");
    }
    const maxAutonomousTurns = snapshot?.maxAutonomousTurns ??
      options.maxAutonomousTurns ?? DEFAULT_AUTONOMOUS_TURN_BUDGET;
    if (!Number.isSafeInteger(maxAutonomousTurns) || maxAutonomousTurns < 0) {
      throw new TypeError("maxAutonomousTurns must be a non-negative integer");
    }
    if (
      snapshot !== undefined && options.maxAutonomousTurns !== undefined &&
      options.maxAutonomousTurns !== snapshot.maxAutonomousTurns
    ) {
      throw new TypeError("snapshot autonomous-turn budget does not match options");
    }

    this.#personas = Object.freeze([...canonicalPersonas]);
    this.#personaSet = new Set(canonicalPersonas);
    this.#maxAutonomousTurns = maxAutonomousTurns;
    if (snapshot !== undefined) this.#restore(snapshot);
  }

  static restore(
    personas: readonly string[],
    snapshot: DirectorSnapshot,
    options: DirectorOptions = {},
  ): Director {
    return new Director(personas, options, snapshot);
  }

  cancel(): void {
    this.#cancelled = true;
  }

  get duplicateTrackingCount(): number {
    return this.#seenOrder.length;
  }

  snapshot(): DirectorSnapshot {
    return Object.freeze({
      version: 1 as const,
      autonomousTurns: this.#autonomousTurns,
      acceptedHumanEventNumber: this.#acceptedHumanEventNumber,
      fallbackIndex: this.#fallbackIndex,
      cancelled: this.#cancelled,
      maxAutonomousTurns: this.#maxAutonomousTurns,
      lastSelectedAt: Object.freeze([...this.#lastSelectedAt.entries()].map((entry) => Object.freeze(entry))),
      seen: Object.freeze(this.#seenOrder.map((entry) => Object.freeze([...entry] as const))),
    });
  }

  setMuted(personaId: string, muted: boolean): void {
    if (!this.#personaSet.has(personaId)) {
      throw new RangeError(`unknown persona: ${personaId}`);
    }
    if (muted) this.#muted.add(personaId);
    else this.#muted.delete(personaId);
  }

  schedule(event: unknown): DirectorDecision {
    if (this.#cancelled) return decision(null, DIRECTOR_REASON.CANCELLED);
    if (!(event instanceof VerifiedDirectorEvent) || event[EVENT_PROOF] !== true) {
      return decision(null, DIRECTOR_REASON.UNVERIFIED_EVENT);
    }
    if (this.#hasSeen(event.namespace, event.eventId)) {
      return decision(null, DIRECTOR_REASON.DUPLICATE);
    }
    this.#recordSeen(event.namespace, event.eventId);

    if (!event.isHuman) return decision(null, DIRECTOR_REASON.SELF_TRIGGER_BLOCKED);
    if (this.#autonomousTurns >= this.#maxAutonomousTurns) {
      return decision(null, DIRECTOR_REASON.BUDGET_EXHAUSTED);
    }

    this.#acceptedHumanEventNumber += 1;
    if (!event.wantsResponse) return decision(null, DIRECTOR_REASON.DELIBERATE_SILENCE);
    if (this.#personas.length === 0) return decision(null, DIRECTOR_REASON.NO_PERSONA);

    const unmuted = this.#personas.filter((personaId) => !this.#muted.has(personaId));
    if (unmuted.length === 0) return decision(null, DIRECTOR_REASON.NO_ELIGIBLE_PERSONA);

    const onlyUnmuted = unmuted.length === 1 ? unmuted[0] : undefined;
    const speaker = onlyUnmuted === undefined
      ? this.#deterministicEligibleSpeaker()
      : { personaId: onlyUnmuted, index: this.#personas.indexOf(onlyUnmuted) };
    if (speaker === null) return decision(null, DIRECTOR_REASON.COOLDOWN);

    this.#lastSelectedAt.set(speaker.personaId, this.#acceptedHumanEventNumber);
    this.#fallbackIndex = (speaker.index + 1) % this.#personas.length;
    this.#autonomousTurns += 1;
    return decision(speaker.personaId, DIRECTOR_REASON.SELECTED);
  }

  #restore(snapshot: DirectorSnapshot): void {
    if (snapshot === null || typeof snapshot !== "object" || snapshot.version !== 1 ||
        Object.keys(snapshot).sort().join("\0") !== DIRECTOR_SNAPSHOT_KEYS.join("\0")) {
      throw new TypeError("director snapshot version is invalid");
    }
    this.#autonomousTurns = requireNonNegativeInteger(snapshot.autonomousTurns, "snapshot autonomousTurns");
    this.#acceptedHumanEventNumber = requireNonNegativeInteger(
      snapshot.acceptedHumanEventNumber,
      "snapshot acceptedHumanEventNumber",
    );
    if (this.#autonomousTurns > this.#maxAutonomousTurns ||
        this.#autonomousTurns > this.#acceptedHumanEventNumber) {
      throw new TypeError("snapshot autonomousTurns is inconsistent");
    }
    this.#fallbackIndex = requireNonNegativeInteger(snapshot.fallbackIndex, "snapshot fallbackIndex");
    if (this.#personas.length === 0 ? this.#fallbackIndex !== 0 : this.#fallbackIndex >= this.#personas.length) {
      throw new TypeError("snapshot fallbackIndex is outside the roster");
    }
    if (typeof snapshot.cancelled !== "boolean") throw new TypeError("snapshot cancelled is invalid");
    this.#cancelled = snapshot.cancelled;
    if (!Array.isArray(snapshot.lastSelectedAt) || !Array.isArray(snapshot.seen) ||
        snapshot.seen.length > DIRECTOR_LIMITS.MAX_TRACKED_EVENT_IDENTITIES) {
      throw new TypeError("director snapshot collections are invalid");
    }
    const selectedPersonas = new Set<string>();
    const selectionEventNumbers = new Set<number>();
    for (const entry of snapshot.lastSelectedAt) {
      if (!Array.isArray(entry) || entry.length !== 2 || !this.#personaSet.has(entry[0]) ||
          selectedPersonas.has(entry[0])) {
        throw new TypeError("snapshot lastSelectedAt is invalid");
      }
      const eventNumber = requireNonNegativeInteger(entry[1], "snapshot event number");
      if (eventNumber === 0 || eventNumber > this.#acceptedHumanEventNumber ||
          selectionEventNumbers.has(eventNumber)) {
        throw new TypeError("snapshot lastSelectedAt is inconsistent");
      }
      selectedPersonas.add(entry[0]);
      selectionEventNumbers.add(eventNumber);
      this.#lastSelectedAt.set(entry[0], eventNumber);
    }
    if (this.#lastSelectedAt.size > this.#autonomousTurns ||
        (this.#autonomousTurns === 0) !== (this.#lastSelectedAt.size === 0)) {
      throw new TypeError("snapshot selection history is inconsistent");
    }
    if (this.#autonomousTurns === 0) {
      if (this.#fallbackIndex !== 0) {
        throw new TypeError("snapshot fallbackIndex is inconsistent with selection history");
      }
    } else {
      const latestSelection = [...this.#lastSelectedAt.entries()].reduce((latest, entry) =>
        entry[1] > latest[1] ? entry : latest,
      );
      if (latestSelection[1] < this.#autonomousTurns) {
        throw new TypeError("snapshot selection history is inconsistent");
      }
      const expectedFallback = (this.#personas.indexOf(latestSelection[0]) + 1) % this.#personas.length;
      if (this.#fallbackIndex !== expectedFallback) {
        throw new TypeError("snapshot fallbackIndex is inconsistent with selection history");
      }
    }
    if (snapshot.seen.length < Math.min(
      this.#acceptedHumanEventNumber,
      DIRECTOR_LIMITS.MAX_TRACKED_EVENT_IDENTITIES,
    )) {
      throw new TypeError("snapshot seen history is inconsistent");
    }
    for (const entry of snapshot.seen) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError("snapshot seen identity is invalid");
      const namespace = requireCanonicalIdentifier(entry[0], "snapshot namespace", DIRECTOR_LIMITS.MAX_NAMESPACE_LENGTH);
      const eventId = requireCanonicalIdentifier(entry[1], "snapshot eventId", DIRECTOR_LIMITS.MAX_EVENT_ID_LENGTH);
      if (this.#hasSeen(namespace, eventId)) throw new TypeError("snapshot seen identities must be unique");
      this.#recordSeen(namespace, eventId);
    }
  }

  #deterministicEligibleSpeaker(): { personaId: string; index: number } | null {
    for (let offset = 0; offset < this.#personas.length; offset += 1) {
      const index = (this.#fallbackIndex + offset) % this.#personas.length;
      const personaId = this.#personas[index];
      if (personaId === undefined || this.#muted.has(personaId)) continue;
      const lastSelectedAt = this.#lastSelectedAt.get(personaId);
      if (lastSelectedAt === undefined || this.#acceptedHumanEventNumber - lastSelectedAt > ONE_EVENT_COOLDOWN) {
        return { personaId, index };
      }
    }
    return null;
  }

  #hasSeen(namespace: string, eventId: string): boolean {
    return this.#seenByNamespace.get(namespace)?.has(eventId) ?? false;
  }

  #recordSeen(namespace: string, eventId: string): void {
    const namespaceEvents = this.#seenByNamespace.get(namespace);
    if (namespaceEvents === undefined) this.#seenByNamespace.set(namespace, new Set([eventId]));
    else namespaceEvents.add(eventId);
    this.#seenOrder.push([namespace, eventId]);

    if (this.#seenOrder.length <= DIRECTOR_LIMITS.MAX_TRACKED_EVENT_IDENTITIES) return;
    const oldest = this.#seenOrder.shift();
    if (oldest === undefined) return;
    const [oldestNamespace, oldestEventId] = oldest;
    const oldestNamespaceEvents = this.#seenByNamespace.get(oldestNamespace);
    oldestNamespaceEvents?.delete(oldestEventId);
    if (oldestNamespaceEvents?.size === 0) this.#seenByNamespace.delete(oldestNamespace);
  }
}
