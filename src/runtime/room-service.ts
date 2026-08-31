import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  appendEventInTransaction,
  canonicalJson,
  withImmediateTransaction,
} from "../db/index.js";
import type {
  GenerationProvider,
  ProviderResult,
} from "../providers/provider.js";
import {
  DIRECTOR_REASON,
  type DirectorDecision,
} from "./director.js";

const DEFAULT_AUTONOMOUS_TURN_BUDGET = 10;
const DEFAULT_PENDING_WORK_LEASE_MS = 30_000;
const DEFAULT_PENDING_WORK_POLL_MS = 50;
const MAX_PENDING_WORK_LEASE_MS = 300_000;

export const ROOM_SERVICE_LIMITS = Object.freeze({
  MAX_IDENTIFIER_LENGTH: 256,
  MAX_MESSAGE_LENGTH: 16_384,
  MAX_PROVIDER_TEXT_LENGTH: 16_384,
} as const);

export interface RoomCommand {
  readonly requestId: string;
  readonly roomId: string;
}

export interface SendMessageCommand extends RoomCommand {
  readonly text: string;
  readonly wantsResponse?: boolean;
}

export interface PauseCommand extends RoomCommand {}
export interface ResumeCommand extends RoomCommand {}
export interface StopCommand extends RoomCommand {}

export interface PersonaControlCommand extends RoomCommand {
  readonly personaId: string;
}

export interface MuteCommand extends PersonaControlCommand {}
export interface UnmuteCommand extends PersonaControlCommand {}

export type MessageOutcome = "not_scheduled" | "silence" | "stale" | "text";

export interface SendMessageResult {
  readonly kind: "message";
  readonly requestId: string;
  readonly humanEventSequence: number;
  readonly directorEventSequence: number;
  readonly personaEventSequence: number | null;
  readonly decision: DirectorDecision;
  readonly outcome: MessageOutcome;
  readonly generation: number;
}

export interface RoomControlResult {
  readonly kind: "pause" | "resume" | "stop";
  readonly requestId: string;
  readonly status: "active" | "paused" | "stopped";
  readonly generation: number;
  readonly changed: boolean;
}

export interface PersonaControlResult {
  readonly kind: "mute" | "unmute";
  readonly requestId: string;
  readonly personaId: string;
  readonly muted: boolean;
  readonly generation: number;
  readonly changed: boolean;
}

export interface RoomServiceOptions {
  readonly database: DatabaseSync;
  readonly provider: GenerationProvider;
  readonly maxAutonomousTurns?: number;
  readonly now?: () => number;
  readonly pendingWorkLeaseMs?: number;
  readonly pendingWorkPollMs?: number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface RoomRow {
  readonly generation: number;
  readonly status: "active" | "paused" | "stopped";
}

interface DirectorStateRow {
  readonly autonomous_turns: number;
  readonly last_human_event_sequence: number | null;
  readonly last_speaker_id: string | null;
}

interface PersonaRow {
  readonly id: string;
  readonly muted: number;
  readonly sort_order: number;
}

interface CommandRow {
  readonly claim_expires_at: number | null;
  readonly claim_owner: string | null;
  readonly request_digest: string;
  readonly result_json: string;
}

interface PendingMessage {
  readonly state: "pending";
  readonly requestId: string;
  readonly humanEventSequence: number;
  readonly directorEventSequence: number;
  readonly decision: DirectorDecision;
  readonly generation: number;
  readonly prompt: string;
}

interface CompleteCommand<T> {
  readonly state: "complete";
  readonly result: T;
}

interface PreparedMessage {
  readonly claimOwner?: string;
  readonly complete?: SendMessageResult;
  readonly observedUntil?: number;
  readonly pending?: PendingMessage;
}

interface InFlightMessage {
  readonly digest: string;
  readonly promise: Promise<SendMessageResult>;
}

interface ActiveGeneration {
  readonly controller: AbortController;
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolveWait();
    }
    function abort(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function canonicalIdentifier(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > ROOM_SERVICE_LIMITS.MAX_IDENTIFIER_LENGTH
  ) {
    throw new TypeError(`${field} must be a canonical nonblank identifier`);
  }
  return value;
}

function messageText(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > ROOM_SERVICE_LIMITS.MAX_MESSAGE_LENGTH
  ) {
    throw new TypeError("text must be a nonblank bounded string");
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseStored<T>(value: string): CompleteCommand<T> | PendingMessage {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Stored command result is invalid");
  }
  const state = (parsed as { state?: unknown }).state;
  if (state !== "complete" && state !== "pending") {
    throw new Error("Stored command result has an unknown state");
  }
  return parsed as CompleteCommand<T> | PendingMessage;
}

function completed<T>(result: T): CompleteCommand<T> {
  return { state: "complete", result };
}

function assertMatchingDigest(row: CommandRow, requestDigest: string): void {
  if (row.request_digest !== requestDigest) {
    throw new Error("Request id was already used for a different command");
  }
}

function roomError(status: RoomRow["status"]): Error {
  return new Error(`Room is ${status}`);
}

export class RoomService {
  readonly #database: DatabaseSync;
  readonly #provider: GenerationProvider;
  readonly #maxAutonomousTurns: number;
  readonly #now: () => number;
  readonly #pendingWorkLeaseMs: number;
  readonly #pendingWorkPollMs: number;
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #inFlight = new Map<string, InFlightMessage>();
  readonly #controllers = new Map<string, Set<ActiveGeneration>>();

  constructor(options: RoomServiceOptions) {
    if (
      !Number.isInteger(options.maxAutonomousTurns ?? DEFAULT_AUTONOMOUS_TURN_BUDGET) ||
      (options.maxAutonomousTurns ?? DEFAULT_AUTONOMOUS_TURN_BUDGET) < 0
    ) {
      throw new TypeError("maxAutonomousTurns must be a non-negative integer");
    }
    const pendingWorkLeaseMs =
      options.pendingWorkLeaseMs ?? DEFAULT_PENDING_WORK_LEASE_MS;
    const pendingWorkPollMs =
      options.pendingWorkPollMs ?? DEFAULT_PENDING_WORK_POLL_MS;
    if (
      !Number.isSafeInteger(pendingWorkLeaseMs) ||
      pendingWorkLeaseMs <= 0 ||
      pendingWorkLeaseMs > MAX_PENDING_WORK_LEASE_MS
    ) {
      throw new TypeError("pendingWorkLeaseMs must be a bounded positive integer");
    }
    if (
      !Number.isSafeInteger(pendingWorkPollMs) ||
      pendingWorkPollMs <= 0 ||
      pendingWorkPollMs > pendingWorkLeaseMs
    ) {
      throw new TypeError("pendingWorkPollMs must not exceed the work lease");
    }
    this.#database = options.database;
    this.#provider = options.provider;
    this.#maxAutonomousTurns =
      options.maxAutonomousTurns ?? DEFAULT_AUTONOMOUS_TURN_BUDGET;
    this.#now = options.now ?? Date.now;
    this.#pendingWorkLeaseMs = pendingWorkLeaseMs;
    this.#pendingWorkPollMs = pendingWorkPollMs;
    this.#wait = options.wait ?? defaultWait;
  }

  sendMessage(command: SendMessageCommand): Promise<SendMessageResult> {
    const normalized = {
      kind: "sendMessage" as const,
      roomId: canonicalIdentifier(command.roomId, "roomId"),
      requestId: canonicalIdentifier(command.requestId, "requestId"),
      text: messageText(command.text),
      wantsResponse: command.wantsResponse ?? true,
    };
    if (typeof normalized.wantsResponse !== "boolean") {
      throw new TypeError("wantsResponse must be a boolean");
    }
    const requestDigest = digest(normalized);
    const key = canonicalJson([normalized.roomId, normalized.requestId]);
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      if (existing.digest !== requestDigest) {
        return Promise.reject(
          new Error("Request id was already used for a different command"),
        );
      }
      return existing.promise;
    }

    const promise = Promise.resolve().then(async () =>
      this.#executeMessage(normalized, requestDigest),
    );
    this.#inFlight.set(key, { digest: requestDigest, promise });
    void promise.finally(() => {
      if (this.#inFlight.get(key)?.promise === promise) {
        this.#inFlight.delete(key);
      }
    }).catch(() => undefined);
    return promise;
  }

  pause(command: PauseCommand): Promise<RoomControlResult> {
    return this.#roomControl("pause", command);
  }

  resume(command: ResumeCommand): Promise<RoomControlResult> {
    return this.#roomControl("resume", command);
  }

  stop(command: StopCommand): Promise<RoomControlResult> {
    return this.#roomControl("stop", command);
  }

  mute(command: MuteCommand): Promise<PersonaControlResult> {
    return this.#personaControl("mute", command);
  }

  unmute(command: UnmuteCommand): Promise<PersonaControlResult> {
    return this.#personaControl("unmute", command);
  }

  async #executeMessage(
    command: {
      readonly roomId: string;
      readonly requestId: string;
      readonly text: string;
      readonly wantsResponse: boolean;
    },
    requestDigest: string,
  ): Promise<SendMessageResult> {
    const claimOwner = randomUUID();
    const observation = new AbortController();
    let generated = false;
    let providerResult: ProviderResult | undefined;
    while (true) {
      const prepared = this.#prepareMessage(command, requestDigest, claimOwner);
      if (prepared.complete !== undefined) {
        return prepared.complete;
      }
      if (prepared.pending === undefined) {
        throw new Error("Message command was not prepared");
      }
      if (prepared.claimOwner === claimOwner) {
        if (!generated) {
          providerResult = await this.#generateMessage(
            command.roomId,
            command.requestId,
            prepared.pending,
            claimOwner,
          );
          generated = true;
        }
        const complete = this.#completeMessage(
          command.roomId,
          command.requestId,
          prepared.pending,
          providerResult,
          claimOwner,
        );
        if (complete !== undefined) {
          return complete;
        }
        continue;
      }
      const remaining = Math.max(
        1,
        (prepared.observedUntil ?? this.#currentTime()) - this.#currentTime(),
      );
      await this.#wait(
        Math.min(this.#pendingWorkPollMs, remaining),
        observation.signal,
      );
    }
  }

  #prepareMessage(
    command: {
      readonly roomId: string;
      readonly requestId: string;
      readonly text: string;
      readonly wantsResponse: boolean;
    },
    requestDigest: string,
    claimOwner: string,
  ): PreparedMessage {
    return withImmediateTransaction(this.#database, () => {
      const now = this.#currentTime();
      const prior = this.#findCommand(command.roomId, command.requestId);
      if (prior !== undefined) {
        assertMatchingDigest(prior, requestDigest);
        const stored = parseStored<SendMessageResult>(prior.result_json);
        if (stored.state === "complete") {
          return { complete: stored.result };
        }
        if (
          prior.claim_owner === null ||
          prior.claim_expires_at === null ||
          prior.claim_expires_at <= now
        ) {
          const claimExpiresAt = now + this.#pendingWorkLeaseMs;
          this.#database
            .prepare(
              `UPDATE commands SET claim_owner = ?, claim_expires_at = ?
               WHERE room_id = ? AND request_id = ?`,
            )
            .run(claimOwner, claimExpiresAt, command.roomId, command.requestId);
          return { claimOwner, pending: stored };
        }
        return { observedUntil: prior.claim_expires_at, pending: stored };
      }

      const room = this.#room(command.roomId);
      if (room.status !== "active") {
        throw roomError(room.status);
      }
      const state = this.#database
        .prepare(
          `SELECT autonomous_turns, last_human_event_sequence, last_speaker_id
           FROM director_state WHERE room_id = ?`,
        )
        .get(command.roomId) as DirectorStateRow | undefined;
      if (state === undefined) {
        throw new Error(`Missing director state for room: ${command.roomId}`);
      }

      const human = appendEventInTransaction(this.#database, command.roomId, {
        type: "human_message",
        participantId: "human",
        text: command.text,
      });
      const decision = this.#decide(command.roomId, state, command.wantsResponse);
      const director = appendEventInTransaction(this.#database, command.roomId, {
        type: "director_decision",
        sourceEventSequence: human.sequence,
        speaker: decision.speaker,
        reason: decision.reason,
      });

      this.#database
        .prepare(
          `UPDATE director_state
           SET last_human_event_sequence =
                 CASE WHEN ? IS NULL THEN last_human_event_sequence ELSE ? END,
               last_speaker_id =
                 CASE WHEN ? IS NULL THEN last_speaker_id ELSE ? END,
               autonomous_turns = autonomous_turns + CASE WHEN ? IS NULL THEN 0 ELSE 1 END,
               scheduling_window_generation = ?, updated_at = CURRENT_TIMESTAMP
           WHERE room_id = ?`,
        )
        .run(
          decision.speaker,
          human.sequence,
          decision.speaker,
          decision.speaker,
          decision.speaker,
          room.generation,
          command.roomId,
        );

      const pending: PendingMessage = {
        state: "pending",
        requestId: command.requestId,
        humanEventSequence: human.sequence,
        directorEventSequence: director.sequence,
        decision,
        generation: room.generation,
        prompt: command.text,
      };

      if (decision.speaker === null) {
        const result: SendMessageResult = {
          kind: "message",
          requestId: command.requestId,
          humanEventSequence: human.sequence,
          directorEventSequence: director.sequence,
          personaEventSequence: null,
          decision,
          outcome: "not_scheduled",
          generation: room.generation,
        };
        this.#insertCommand(
          command.roomId,
          command.requestId,
          requestDigest,
          completed(result),
        );
        return { complete: result };
      }

      this.#insertCommand(
        command.roomId,
        command.requestId,
        requestDigest,
        pending,
        claimOwner,
        now + this.#pendingWorkLeaseMs,
      );
      return { claimOwner, pending };
    });
  }

  #decide(
    roomId: string,
    state: DirectorStateRow,
    wantsResponse: boolean,
  ): DirectorDecision {
    if (state.autonomous_turns >= this.#maxAutonomousTurns) {
      return { speaker: null, reason: DIRECTOR_REASON.BUDGET_EXHAUSTED };
    }
    if (!wantsResponse) {
      return { speaker: null, reason: DIRECTOR_REASON.DELIBERATE_SILENCE };
    }
    const personas = this.#database
      .prepare(
        `SELECT id, muted, sort_order FROM participants
         WHERE room_id = ? AND kind = 'persona' ORDER BY sort_order`,
      )
      .all(roomId) as unknown as PersonaRow[];
    if (personas.length === 0) {
      return { speaker: null, reason: DIRECTOR_REASON.NO_PERSONA };
    }
    const unmuted = personas.filter(({ muted }) => muted === 0);
    if (unmuted.length === 0) {
      return { speaker: null, reason: DIRECTOR_REASON.NO_ELIGIBLE_PERSONA };
    }

    const lastIndex = personas.findIndex(({ id }) => id === state.last_speaker_id);
    const startIndex = lastIndex < 0 ? 0 : (lastIndex + 1) % personas.length;
    const speakerOnCooldown =
      state.last_speaker_id !== null &&
      state.last_human_event_sequence !== null &&
      (
        this.#database
          .prepare(
            `SELECT count(*) AS count FROM events
             WHERE room_id = ? AND sequence > ?
               AND json_extract(event_json, '$.type') = 'human_message'`,
          )
          .get(roomId, state.last_human_event_sequence) as { count: number }
      ).count <= 1;
    for (let offset = 0; offset < personas.length; offset += 1) {
      const persona = personas[(startIndex + offset) % personas.length];
      if (
        persona !== undefined &&
        persona.muted === 0 &&
        (!speakerOnCooldown || persona.id !== state.last_speaker_id)
      ) {
        return { speaker: persona.id, reason: DIRECTOR_REASON.SELECTED };
      }
    }
    return { speaker: null, reason: DIRECTOR_REASON.COOLDOWN };
  }

  async #generateMessage(
    roomId: string,
    requestId: string,
    pending: PendingMessage,
    claimOwner: string,
  ): Promise<ProviderResult | undefined> {
    const speaker = pending.decision.speaker;
    if (speaker === null) {
      throw new Error("Cannot generate without a selected speaker");
    }
    const controller = new AbortController();
    const active = { controller };
    const stopLease = new AbortController();
    const leaseMaintenance = this.#maintainClaim(
      roomId,
      requestId,
      claimOwner,
      controller,
      stopLease.signal,
    );
    this.#addController(roomId, active);
    try {
      if (this.#isStale(roomId, pending.generation, speaker)) {
        return undefined;
      }
      try {
        const result: unknown = await this.#provider.generate(
          {
            id: `${roomId}:${pending.generation}:${pending.humanEventSequence}:${speaker}`,
            personaId: speaker,
            prompt: pending.prompt,
          },
          controller.signal,
        );
        return this.#validatedProviderResult(result);
      } catch (error) {
        if (this.#isStale(roomId, pending.generation, speaker)) {
          return undefined;
        }
        this.#releaseClaim(roomId, requestId, claimOwner);
        throw error;
      }
    } finally {
      stopLease.abort();
      await leaseMaintenance;
      this.#removeController(roomId, active);
    }
  }

  #completeMessage(
    roomId: string,
    requestId: string,
    pending: PendingMessage,
    providerResult: ProviderResult | undefined,
    claimOwner: string,
  ): SendMessageResult | undefined {
    return withImmediateTransaction(this.#database, () => {
      const row = this.#findCommand(roomId, requestId);
      if (row === undefined) {
        throw new Error("Pending command disappeared");
      }
      const stored = parseStored<SendMessageResult>(row.result_json);
      if (stored.state === "complete") {
        return stored.result;
      }
      if (
        row.claim_owner !== claimOwner ||
        row.claim_expires_at === null ||
        row.claim_expires_at <= this.#currentTime()
      ) {
        return undefined;
      }

      const speaker = pending.decision.speaker;
      if (speaker === null) {
        throw new Error("Stored pending command has no speaker");
      }
      const stale = this.#isStale(roomId, pending.generation, speaker);
      let personaEventSequence: number | null = null;
      let outcome: MessageOutcome;
      if (stale || providerResult === undefined) {
        outcome = "stale";
      } else if (providerResult.kind === "silence") {
        outcome = "silence";
      } else {
        const persona = appendEventInTransaction(this.#database, roomId, {
          type: "persona_message",
          participantId: speaker,
          sourceEventSequence: pending.humanEventSequence,
          text: providerResult.text,
        });
        personaEventSequence = persona.sequence;
        outcome = "text";
      }

      const result: SendMessageResult = {
        kind: "message",
        requestId,
        humanEventSequence: pending.humanEventSequence,
        directorEventSequence: pending.directorEventSequence,
        personaEventSequence,
        decision: pending.decision,
        outcome,
        generation: pending.generation,
      };
      this.#database
        .prepare(
          `UPDATE commands
           SET result_json = ?, claim_owner = NULL, claim_expires_at = NULL
           WHERE room_id = ? AND request_id = ? AND claim_owner = ?`,
        )
        .run(canonicalJson(completed(result)), roomId, requestId, claimOwner);
      return result;
    });
  }

  #roomControl(
    kind: "pause" | "resume" | "stop",
    command: RoomCommand,
  ): Promise<RoomControlResult> {
    try {
      const roomId = canonicalIdentifier(command.roomId, "roomId");
      const requestId = canonicalIdentifier(command.requestId, "requestId");
      const requestDigest = digest({ kind, roomId, requestId });
      const operation = withImmediateTransaction(this.#database, () => {
        const prior = this.#findCommand(roomId, requestId);
        if (prior !== undefined) {
          assertMatchingDigest(prior, requestDigest);
          const stored = parseStored<RoomControlResult>(prior.result_json);
          if (stored.state !== "complete") {
            throw new Error("Control command cannot be pending");
          }
          return { abort: false, result: stored.result };
        }

        const room = this.#room(roomId);
        if (kind === "resume" && room.status === "stopped") {
          throw roomError(room.status);
        }
        if (kind === "pause" && room.status === "stopped") {
          throw roomError(room.status);
        }
        const targetStatus =
          kind === "pause" ? "paused" : kind === "resume" ? "active" : "stopped";
        const changed = room.status !== targetStatus;
        const fencesGeneration =
          changed && (kind === "pause" || kind === "stop");
        if (changed) {
          this.#database
            .prepare(
              `UPDATE rooms SET status = ?, generation = generation + ? WHERE id = ?`,
            )
            .run(targetStatus, fencesGeneration ? 1 : 0, roomId);
          if (fencesGeneration) {
            this.#releaseRoomClaims(roomId);
          }
        }
        const updated = this.#room(roomId);
        const controlResult: RoomControlResult = {
          kind,
          requestId,
          status: updated.status,
          generation: updated.generation,
          changed,
        };
        this.#insertCommand(
          roomId,
          requestId,
          requestDigest,
          completed(controlResult),
        );
        return { abort: fencesGeneration, result: controlResult };
      });
      if (operation.abort) {
        this.#abortRoom(roomId);
      }
      return Promise.resolve(operation.result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #personaControl(
    kind: "mute" | "unmute",
    command: PersonaControlCommand,
  ): Promise<PersonaControlResult> {
    try {
      const roomId = canonicalIdentifier(command.roomId, "roomId");
      const requestId = canonicalIdentifier(command.requestId, "requestId");
      const personaId = canonicalIdentifier(command.personaId, "personaId");
      const requestDigest = digest({ kind, roomId, requestId, personaId });
      const operation = withImmediateTransaction(this.#database, () => {
        const prior = this.#findCommand(roomId, requestId);
        if (prior !== undefined) {
          assertMatchingDigest(prior, requestDigest);
          const stored = parseStored<PersonaControlResult>(prior.result_json);
          if (stored.state !== "complete") {
            throw new Error("Control command cannot be pending");
          }
          return { abort: false, result: stored.result };
        }
        const room = this.#room(roomId);
        if (room.status === "stopped") {
          throw roomError(room.status);
        }
        const persona = this.#database
          .prepare(
            `SELECT id, muted, sort_order FROM participants
             WHERE room_id = ? AND id = ? AND kind = 'persona'`,
          )
          .get(roomId, personaId) as PersonaRow | undefined;
        if (persona === undefined) {
          throw new Error(`Unknown persona: ${personaId}`);
        }
        const muted = kind === "mute";
        const changed = persona.muted !== (muted ? 1 : 0);
        if (changed) {
          this.#database
            .prepare("UPDATE participants SET muted = ? WHERE room_id = ? AND id = ?")
            .run(muted ? 1 : 0, roomId, personaId);
          if (muted) {
            this.#database
              .prepare("UPDATE rooms SET generation = generation + 1 WHERE id = ?")
              .run(roomId);
            this.#releaseRoomClaims(roomId);
          }
        }
        const updatedRoom = this.#room(roomId);
        const controlResult: PersonaControlResult = {
          kind,
          requestId,
          personaId,
          muted,
          generation: updatedRoom.generation,
          changed,
        };
        this.#insertCommand(
          roomId,
          requestId,
          requestDigest,
          completed(controlResult),
        );
        return { abort: changed && muted, result: controlResult };
      });
      if (operation.abort) {
        this.#abortRoom(roomId);
      }
      return Promise.resolve(operation.result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #room(roomId: string): RoomRow {
    const room = this.#database
      .prepare("SELECT status, generation FROM rooms WHERE id = ?")
      .get(roomId) as RoomRow | undefined;
    if (room === undefined) {
      throw new Error(`Unknown room: ${roomId}`);
    }
    return room;
  }

  #findCommand(roomId: string, requestId: string): CommandRow | undefined {
    return this.#database
      .prepare(
        `SELECT request_digest, result_json, claim_owner, claim_expires_at FROM commands
         WHERE room_id = ? AND request_id = ?`,
      )
      .get(roomId, requestId) as CommandRow | undefined;
  }

  #insertCommand(
    roomId: string,
    requestId: string,
    requestDigest: string,
    result: unknown,
    claimOwner: string | null = null,
    claimExpiresAt: number | null = null,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO commands(
           room_id, request_id, request_digest, result_json,
           claim_owner, claim_expires_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        roomId,
        requestId,
        requestDigest,
        canonicalJson(result),
        claimOwner,
        claimExpiresAt,
      );
  }

  #currentTime(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("now must return a non-negative safe integer");
    }
    return now;
  }

  async #maintainClaim(
    roomId: string,
    requestId: string,
    claimOwner: string,
    controller: AbortController,
    stopSignal: AbortSignal,
  ): Promise<void> {
    const interval = Math.max(1, Math.floor(this.#pendingWorkLeaseMs / 3));
    while (!stopSignal.aborted) {
      try {
        await this.#wait(interval, stopSignal);
      } catch {
        return;
      }
      if (stopSignal.aborted) {
        return;
      }
      try {
        const renewed = withImmediateTransaction(this.#database, () =>
          this.#database
            .prepare(
              `UPDATE commands SET claim_expires_at = ?
               WHERE room_id = ? AND request_id = ? AND claim_owner = ?
                 AND json_extract(result_json, '$.state') = 'pending'`,
            )
            .run(
              this.#currentTime() + this.#pendingWorkLeaseMs,
              roomId,
              requestId,
              claimOwner,
            ).changes,
        );
        if (renewed !== 1) {
          controller.abort(new Error("Pending provider claim was lost"));
          return;
        }
      } catch (error) {
        controller.abort(error);
        return;
      }
    }
  }

  #releaseClaim(roomId: string, requestId: string, claimOwner: string): void {
    withImmediateTransaction(this.#database, () => {
      this.#database
        .prepare(
          `UPDATE commands SET claim_owner = NULL, claim_expires_at = NULL
           WHERE room_id = ? AND request_id = ? AND claim_owner = ?
             AND json_extract(result_json, '$.state') = 'pending'`,
        )
        .run(roomId, requestId, claimOwner);
    });
  }

  #releaseRoomClaims(roomId: string): void {
    this.#database
      .prepare(
        `UPDATE commands SET claim_owner = NULL, claim_expires_at = NULL
         WHERE room_id = ? AND claim_owner IS NOT NULL
           AND json_extract(result_json, '$.state') = 'pending'`,
      )
      .run(roomId);
  }

  #validatedProviderResult(value: unknown): ProviderResult {
    if (value === null || typeof value !== "object") {
      throw new TypeError("Provider result must be an object");
    }
    const result = value as { readonly kind?: unknown; readonly text?: unknown };
    if (result.kind === "silence") {
      return { kind: "silence" };
    }
    if (
      result.kind !== "text" ||
      typeof result.text !== "string" ||
      result.text.length === 0 ||
      result.text.length > ROOM_SERVICE_LIMITS.MAX_PROVIDER_TEXT_LENGTH
    ) {
      throw new TypeError("Provider text must be a nonempty bounded string");
    }
    return { kind: "text", text: result.text };
  }

  #isStale(roomId: string, generation: number, personaId: string): boolean {
    const row = this.#database
      .prepare(
        `SELECT rooms.status, rooms.generation, participants.muted
         FROM rooms JOIN participants
           ON participants.room_id = rooms.id AND participants.id = ?
         WHERE rooms.id = ?`,
      )
      .get(personaId, roomId) as
      | { generation: number; muted: number; status: RoomRow["status"] }
      | undefined;
    return (
      row === undefined ||
      row.status !== "active" ||
      row.generation !== generation ||
      row.muted !== 0
    );
  }

  #addController(roomId: string, active: ActiveGeneration): void {
    const controllers = this.#controllers.get(roomId);
    if (controllers === undefined) {
      this.#controllers.set(roomId, new Set([active]));
    } else {
      controllers.add(active);
    }
  }

  #removeController(roomId: string, active: ActiveGeneration): void {
    const controllers = this.#controllers.get(roomId);
    controllers?.delete(active);
    if (controllers?.size === 0) {
      this.#controllers.delete(roomId);
    }
  }

  #abortRoom(roomId: string): void {
    for (const active of this.#controllers.get(roomId) ?? []) {
      active.controller.abort();
    }
  }
}
