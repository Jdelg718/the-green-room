const EVENT_PROOF = Symbol("trusted-director-event");
const ONE_EVENT_COOLDOWN = 1;
const DEFAULT_AUTONOMOUS_TURN_BUDGET = 10;
export const DIRECTOR_LIMITS = Object.freeze({
    MAX_NAMESPACE_LENGTH: 128,
    MAX_EVENT_ID_LENGTH: 256,
    MAX_TRACKED_EVENT_IDENTITIES: 500,
});
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
});
class VerifiedDirectorEvent {
    namespace;
    eventId;
    isHuman;
    text;
    wantsResponse;
    [EVENT_PROOF] = true;
    constructor(namespace, eventId, isHuman, text, wantsResponse) {
        this.namespace = namespace;
        this.eventId = eventId;
        this.isHuman = isHuman;
        this.text = text;
        this.wantsResponse = wantsResponse;
        Object.freeze(this);
    }
}
function requireCanonicalIdentifier(value, field, maxLength) {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${field} must be a canonical nonblank string`);
    }
    if (maxLength !== undefined && value.length > maxLength) {
        throw new TypeError(`${field} must be at most ${maxLength} characters`);
    }
    return value;
}
function requireNonNegativeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`);
    }
    return value;
}
export class TrustedEventAdapter {
    #namespace;
    constructor(namespace) {
        this.#namespace = requireCanonicalIdentifier(namespace, "namespace", DIRECTOR_LIMITS.MAX_NAMESPACE_LENGTH);
    }
    humanEvent(eventId, text, wantsResponse = true) {
        return this.#event(eventId, true, text, wantsResponse);
    }
    nonHumanEvent(eventId, text) {
        return this.#event(eventId, false, text, true);
    }
    #event(eventId, isHuman, text, wantsResponse) {
        return new VerifiedDirectorEvent(this.#namespace, requireCanonicalIdentifier(eventId, "eventId", DIRECTOR_LIMITS.MAX_EVENT_ID_LENGTH), isHuman, text, wantsResponse);
    }
}
function decision(speaker, reason) {
    return Object.freeze({ speaker, reason });
}
export class Director {
    #personas;
    #personaSet;
    #muted = new Set();
    #lastSelectedAt = new Map();
    #seenByNamespace = new Map();
    #seenOrder = [];
    #maxAutonomousTurns;
    #autonomousTurns = 0;
    #acceptedHumanEventNumber = 0;
    #fallbackIndex = 0;
    #cancelled = false;
    constructor(personas, options = {}, snapshot) {
        const canonicalPersonas = personas.map((persona) => requireCanonicalIdentifier(persona, "persona id"));
        if (new Set(canonicalPersonas).size !== canonicalPersonas.length) {
            throw new TypeError("duplicate persona ids are not allowed");
        }
        const maxAutonomousTurns = snapshot?.maxAutonomousTurns ??
            options.maxAutonomousTurns ?? DEFAULT_AUTONOMOUS_TURN_BUDGET;
        if (!Number.isInteger(maxAutonomousTurns) || maxAutonomousTurns < 0) {
            throw new TypeError("maxAutonomousTurns must be a non-negative integer");
        }
        if (snapshot !== undefined && options.maxAutonomousTurns !== undefined &&
            options.maxAutonomousTurns !== snapshot.maxAutonomousTurns) {
            throw new TypeError("snapshot autonomous-turn budget does not match options");
        }
        this.#personas = Object.freeze([...canonicalPersonas]);
        this.#personaSet = new Set(canonicalPersonas);
        this.#maxAutonomousTurns = maxAutonomousTurns;
        if (snapshot !== undefined)
            this.#restore(snapshot);
    }
    static restore(personas, snapshot, options = {}) {
        return new Director(personas, options, snapshot);
    }
    cancel() {
        this.#cancelled = true;
    }
    get duplicateTrackingCount() {
        return this.#seenOrder.length;
    }
    snapshot() {
        return Object.freeze({
            version: 1,
            autonomousTurns: this.#autonomousTurns,
            acceptedHumanEventNumber: this.#acceptedHumanEventNumber,
            fallbackIndex: this.#fallbackIndex,
            cancelled: this.#cancelled,
            maxAutonomousTurns: this.#maxAutonomousTurns,
            lastSelectedAt: Object.freeze([...this.#lastSelectedAt.entries()].map((entry) => Object.freeze(entry))),
            seen: Object.freeze(this.#seenOrder.map((entry) => Object.freeze([...entry]))),
        });
    }
    setMuted(personaId, muted) {
        if (!this.#personaSet.has(personaId)) {
            throw new RangeError(`unknown persona: ${personaId}`);
        }
        if (muted)
            this.#muted.add(personaId);
        else
            this.#muted.delete(personaId);
    }
    schedule(event) {
        if (this.#cancelled)
            return decision(null, DIRECTOR_REASON.CANCELLED);
        if (!(event instanceof VerifiedDirectorEvent) || event[EVENT_PROOF] !== true) {
            return decision(null, DIRECTOR_REASON.UNVERIFIED_EVENT);
        }
        if (this.#hasSeen(event.namespace, event.eventId)) {
            return decision(null, DIRECTOR_REASON.DUPLICATE);
        }
        this.#recordSeen(event.namespace, event.eventId);
        if (!event.isHuman)
            return decision(null, DIRECTOR_REASON.SELF_TRIGGER_BLOCKED);
        if (this.#autonomousTurns >= this.#maxAutonomousTurns) {
            return decision(null, DIRECTOR_REASON.BUDGET_EXHAUSTED);
        }
        this.#acceptedHumanEventNumber += 1;
        if (!event.wantsResponse)
            return decision(null, DIRECTOR_REASON.DELIBERATE_SILENCE);
        if (this.#personas.length === 0)
            return decision(null, DIRECTOR_REASON.NO_PERSONA);
        const unmuted = this.#personas.filter((personaId) => !this.#muted.has(personaId));
        if (unmuted.length === 0)
            return decision(null, DIRECTOR_REASON.NO_ELIGIBLE_PERSONA);
        const onlyUnmuted = unmuted.length === 1 ? unmuted[0] : undefined;
        const speaker = onlyUnmuted === undefined
            ? this.#deterministicEligibleSpeaker()
            : { personaId: onlyUnmuted, index: this.#personas.indexOf(onlyUnmuted) };
        if (speaker === null)
            return decision(null, DIRECTOR_REASON.COOLDOWN);
        this.#lastSelectedAt.set(speaker.personaId, this.#acceptedHumanEventNumber);
        this.#fallbackIndex = (speaker.index + 1) % this.#personas.length;
        this.#autonomousTurns += 1;
        return decision(speaker.personaId, DIRECTOR_REASON.SELECTED);
    }
    #restore(snapshot) {
        if (snapshot === null || typeof snapshot !== "object" || snapshot.version !== 1) {
            throw new TypeError("director snapshot version is invalid");
        }
        this.#autonomousTurns = requireNonNegativeInteger(snapshot.autonomousTurns, "snapshot autonomousTurns");
        this.#acceptedHumanEventNumber = requireNonNegativeInteger(snapshot.acceptedHumanEventNumber, "snapshot acceptedHumanEventNumber");
        this.#fallbackIndex = requireNonNegativeInteger(snapshot.fallbackIndex, "snapshot fallbackIndex");
        if (this.#personas.length === 0 ? this.#fallbackIndex !== 0 : this.#fallbackIndex >= this.#personas.length) {
            throw new TypeError("snapshot fallbackIndex is outside the roster");
        }
        if (typeof snapshot.cancelled !== "boolean")
            throw new TypeError("snapshot cancelled is invalid");
        this.#cancelled = snapshot.cancelled;
        if (!Array.isArray(snapshot.lastSelectedAt) || !Array.isArray(snapshot.seen) ||
            snapshot.seen.length > DIRECTOR_LIMITS.MAX_TRACKED_EVENT_IDENTITIES) {
            throw new TypeError("director snapshot collections are invalid");
        }
        for (const entry of snapshot.lastSelectedAt) {
            if (!Array.isArray(entry) || entry.length !== 2 || !this.#personaSet.has(entry[0])) {
                throw new TypeError("snapshot lastSelectedAt is invalid");
            }
            this.#lastSelectedAt.set(entry[0], requireNonNegativeInteger(entry[1], "snapshot event number"));
        }
        for (const entry of snapshot.seen) {
            if (!Array.isArray(entry) || entry.length !== 2)
                throw new TypeError("snapshot seen identity is invalid");
            const namespace = requireCanonicalIdentifier(entry[0], "snapshot namespace", DIRECTOR_LIMITS.MAX_NAMESPACE_LENGTH);
            const eventId = requireCanonicalIdentifier(entry[1], "snapshot eventId", DIRECTOR_LIMITS.MAX_EVENT_ID_LENGTH);
            if (this.#hasSeen(namespace, eventId))
                throw new TypeError("snapshot seen identities must be unique");
            this.#recordSeen(namespace, eventId);
        }
    }
    #deterministicEligibleSpeaker() {
        for (let offset = 0; offset < this.#personas.length; offset += 1) {
            const index = (this.#fallbackIndex + offset) % this.#personas.length;
            const personaId = this.#personas[index];
            if (personaId === undefined || this.#muted.has(personaId))
                continue;
            const lastSelectedAt = this.#lastSelectedAt.get(personaId);
            if (lastSelectedAt === undefined || this.#acceptedHumanEventNumber - lastSelectedAt > ONE_EVENT_COOLDOWN) {
                return { personaId, index };
            }
        }
        return null;
    }
    #hasSeen(namespace, eventId) {
        return this.#seenByNamespace.get(namespace)?.has(eventId) ?? false;
    }
    #recordSeen(namespace, eventId) {
        const namespaceEvents = this.#seenByNamespace.get(namespace);
        if (namespaceEvents === undefined)
            this.#seenByNamespace.set(namespace, new Set([eventId]));
        else
            namespaceEvents.add(eventId);
        this.#seenOrder.push([namespace, eventId]);
        if (this.#seenOrder.length <= DIRECTOR_LIMITS.MAX_TRACKED_EVENT_IDENTITIES)
            return;
        const oldest = this.#seenOrder.shift();
        if (oldest === undefined)
            return;
        const [oldestNamespace, oldestEventId] = oldest;
        const oldestNamespaceEvents = this.#seenByNamespace.get(oldestNamespace);
        oldestNamespaceEvents?.delete(oldestEventId);
        if (oldestNamespaceEvents?.size === 0)
            this.#seenByNamespace.delete(oldestNamespace);
    }
}
//# sourceMappingURL=director.js.map