import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import type { FastifyInstance, FastifyReply } from "fastify";

import {
  bindRoom,
  createConnectionProfile,
  createModelProfile,
  deleteConnectionProfile,
  disableConnectionProfile,
  observeConnection,
  readConnectionProfile,
  readCurrentConnectionProfile,
  readCurrentModelProfile,
  readEffectiveRoomBinding,
  readModelProfile,
  rebindRoom,
  reviseConnectionProfile,
  reviseModelProfile,
} from "../db/index.js";
import { canonicalCredentialReference, type CredentialStore } from "../providers/credential-store.js";
import { OpenAICompatibleCloudAdapter, type CloudTransport } from "../providers/openai-compatible-cloud.js";
import { isBoundedOpaqueModelId } from "../providers/opaque-model-id.js";
import { isApprovedCloudProviderId, type ApprovedCloudProviderId } from "../providers/provider-definitions.js";
import type { ConnectionProfile } from "../providers/profile-contracts.js";

const PROVIDER_BODY_LIMIT = 16 * 1024;
const MAX_KEY_LENGTH = 8_192;
const MAX_MODEL_RESULTS = 1_024;

class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly publicMessage: string) {
    super(code);
  }
}

export interface ProviderRoutesOptions {
  readonly allowedOrigin: string;
  readonly cloudTransport: CloudTransport;
  readonly credentialStore: CredentialStore;
  readonly database: DatabaseSync;
}

function ordinary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (!ordinary(value) || Reflect.ownKeys(value).length !== required.length ||
      !required.every((key) => Object.hasOwn(value, key)) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !required.includes(key))) {
    throw new ProviderHttpError(400, "invalid_request", "Request body is invalid");
  }
  return value;
}

function canonicalId(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)) {
    throw new ProviderHttpError(400, "invalid_request", "Request body is invalid");
  }
  return value;
}

function revision(value: unknown, allowZero = false): number {
  if (!Number.isInteger(value) || (value as number) < (allowZero ? 0 : 1) || (value as number) > 2_147_483_647) {
    throw new ProviderHttpError(400, "invalid_request", "Request body is invalid");
  }
  return value as number;
}

function credential(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEY_LENGTH || /[\r\n\u0000]/u.test(value)) {
    throw new ProviderHttpError(400, "invalid_request", "Request body is invalid");
  }
  return Buffer.from(value, "utf8");
}

function concreteModel(value: unknown, provider: ApprovedCloudProviderId): string {
  if (!isBoundedOpaqueModelId(value) || (provider === "openrouter" && (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) ||
    value.startsWith("openrouter/") || /:(?:nitro|floor|online|exacto)$/u.test(value)
  ))) throw new ProviderHttpError(400, "invalid_request", "A concrete provider model is required");
  return value;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProviderHttpError(400, "invalid_request", "Request body is invalid");
  }
  return value;
}

function connectionDto(revisionRecord: ReturnType<typeof readCurrentConnectionProfile>) {
  if (revisionRecord === undefined || revisionRecord.profile.target.class !== "approved-provider") return undefined;
  return Object.freeze({
    id: revisionRecord.profile.id,
    revision: revisionRecord.profile.revision,
    definitionId: revisionRecord.profile.target.definitionId,
    state: revisionRecord.state,
    credentialStatus: revisionRecord.state === "enabled" && revisionRecord.profile.credentialRef !== undefined ? "stored" : "not_stored",
  });
}

function currentConnections(database: DatabaseSync): readonly NonNullable<ReturnType<typeof connectionDto>>[] {
  const rows = database.prepare(
    `SELECT r.state, r.profile_json
     FROM connection_profile_revisions r
     JOIN (SELECT profile_id, max(revision) revision FROM connection_profile_revisions GROUP BY profile_id) current
       ON current.profile_id = r.profile_id AND current.revision = r.revision
     ORDER BY r.profile_id`,
  ).all() as unknown as Array<{ state: "enabled" | "disabled" | "deleted"; profile_json: string }>;
  return Object.freeze(rows.map((row) => connectionDto({ state: row.state, profile: JSON.parse(row.profile_json) })!).filter(Boolean));
}

function cloudConnection(database: DatabaseSync, id: string, connectionRevision: number): ConnectionProfile & {
  readonly target: { readonly class: "approved-provider"; readonly definitionId: ApprovedCloudProviderId };
  readonly credentialRef: string;
} {
  const found = readConnectionProfile(database, id, connectionRevision);
  const current = readCurrentConnectionProfile(database, id);
  if (current?.state === "deleted") {
    throw new ProviderHttpError(409, "credential_missing", "The connection credential is missing");
  }
  if (found === undefined || current?.profile.revision !== connectionRevision || found.state !== "enabled" || found.profile.target.class !== "approved-provider") {
    throw new ProviderHttpError(409, "revision_conflict", "Connection revision is not current and enabled");
  }
  if (found.profile.credentialRef === undefined) {
    throw new ProviderHttpError(409, "credential_missing", "The connection credential is missing");
  }
  return found.profile as ConnectionProfile & {
    readonly target: { readonly class: "approved-provider"; readonly definitionId: ApprovedCloudProviderId };
    readonly credentialRef: string;
  };
}

async function withCredential<T>(store: CredentialStore, reference: string, action: (key: string) => Promise<T>): Promise<T> {
  let bytes: Buffer | null;
  try { bytes = await store.get(reference); }
  catch { throw new ProviderHttpError(503, "credential_unavailable", "Credential storage is unavailable"); }
  if (bytes === null) throw new ProviderHttpError(409, "credential_missing", "The connection credential is missing");
  try { return await action(bytes.toString("utf8")); }
  finally { bytes.fill(0); }
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ProviderHttpError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.publicMessage } });
  }
  const message = error instanceof Error ? error.message : "";
  if (/revision conflict|stale|already exists|does not exist|is disabled|is deleted|no capability observation/i.test(message)) {
    return reply.code(409).send({ error: { code: "revision_conflict", message: "Request conflicts with current provider state" } });
  }
  return reply.code(503).send({ error: { code: "provider_unavailable", message: "Provider operation failed" } });
}

function loopbackOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  const family = isIP(host);
  return (family === 4 && host.startsWith("127.")) || (family === 6 && host === "::1");
}

export function registerProviderRoutes(api: FastifyInstance, options: ProviderRoutesOptions): void {
  const routeOptions = { bodyLimit: PROVIDER_BODY_LIMIT } as const;
  const allowCredentialMutation = loopbackOrigin(options.allowedOrigin);
  const requireLoopback = (): void => {
    if (!allowCredentialMutation) throw new ProviderHttpError(403, "loopback_required", "Credential changes are available only from loopback");
  };

  api.get("/api/providers/connections", async () => ({ connections: currentConnections(options.database) }));

  api.post("/api/providers/connections", routeOptions, async (request, reply) => {
    let secret: Buffer | undefined;
    let reference: string | undefined;
    try {
      requireLoopback();
      const body = exact(request.body, ["id", "definitionId", "credential", "acknowledgedConnectionRevision"]);
      const id = canonicalId(body.id);
      if (!isApprovedCloudProviderId(body.definitionId)) throw new ProviderHttpError(400, "invalid_request", "Request body is invalid");
      if (revision(body.acknowledgedConnectionRevision) !== 1) throw new ProviderHttpError(400, "acknowledgement_required", "Cloud disclosure acknowledgement must match the connection revision");
      secret = credential(body.credential);
      reference = canonicalCredentialReference(id, 1);
      await options.credentialStore.put(reference, secret);
      secret = undefined;
      try {
        const created = createConnectionProfile(options.database, {
          id, revision: 1, target: { class: "approved-provider", definitionId: body.definitionId }, credentialRef: reference,
        });
        return reply.code(201).send({ connection: connectionDto(created) });
      } catch (error) {
        await options.credentialStore.delete(reference).catch(() => false);
        throw error;
      }
    } catch (error) {
      secret?.fill(0);
      return sendError(reply, error);
    }
  });

  api.post<{ Params: { connectionId: string } }>("/api/providers/connections/:connectionId/replace", routeOptions, async (request, reply) => {
    let secret: Buffer | undefined;
    let nextReference: string | undefined;
    try {
      requireLoopback();
      const id = canonicalId(request.params.connectionId);
      const body = exact(request.body, ["expectedRevision", "credential", "acknowledgedConnectionRevision"]);
      const expected = revision(body.expectedRevision);
      const current = readCurrentConnectionProfile(options.database, id);
      if (current === undefined || current.profile.revision !== expected || current.state === "deleted" || current.profile.target.class !== "approved-provider") {
        throw new ProviderHttpError(409, "revision_conflict", "Connection revision is stale");
      }
      const nextRevision = expected + 1;
      if (revision(body.acknowledgedConnectionRevision) !== nextRevision) throw new ProviderHttpError(400, "acknowledgement_required", "Cloud disclosure acknowledgement must match the connection revision");
      nextReference = canonicalCredentialReference(id, nextRevision);
      secret = credential(body.credential);
      await options.credentialStore.put(nextReference, secret);
      secret = undefined;
      try {
        const revised = reviseConnectionProfile(options.database, {
          id, revision: nextRevision, target: current.profile.target, credentialRef: nextReference,
        }, expected);
        if (current.profile.credentialRef !== undefined) {
          await options.credentialStore.delete(current.profile.credentialRef).catch(() => false);
        }
        return { connection: connectionDto(revised) };
      } catch (error) {
        await options.credentialStore.delete(nextReference).catch(() => false);
        throw error;
      }
    } catch (error) {
      secret?.fill(0);
      return sendError(reply, error);
    }
  });

  api.post<{ Params: { connectionId: string } }>("/api/providers/connections/:connectionId/disable", routeOptions, async (request, reply) => {
    try {
      requireLoopback();
      const id = canonicalId(request.params.connectionId);
      const body = exact(request.body, ["expectedRevision"]);
      const expected = revision(body.expectedRevision);
      const current = readCurrentConnectionProfile(options.database, id);
      if (current === undefined || current.profile.revision !== expected) throw new ProviderHttpError(409, "revision_conflict", "Connection revision is stale");
      const disabled = disableConnectionProfile(options.database, id, expected);
      if (current.profile.credentialRef !== undefined) await options.credentialStore.delete(current.profile.credentialRef).catch(() => false);
      return { connection: connectionDto(disabled) };
    } catch (error) { return sendError(reply, error); }
  });

  api.delete<{ Params: { connectionId: string } }>("/api/providers/connections/:connectionId", routeOptions, async (request, reply) => {
    try {
      requireLoopback();
      const id = canonicalId(request.params.connectionId);
      const body = exact(request.body, ["expectedRevision"]);
      const expected = revision(body.expectedRevision);
      const current = readCurrentConnectionProfile(options.database, id);
      if (current === undefined) throw new ProviderHttpError(409, "revision_conflict", "Connection does not exist");
      const deleted = deleteConnectionProfile(options.database, id, expected);
      if (current.profile.credentialRef !== undefined) await options.credentialStore.delete(current.profile.credentialRef).catch(() => false);
      return { connection: connectionDto(deleted) };
    } catch (error) { return sendError(reply, error); }
  });

  api.post<{ Params: { connectionId: string } }>("/api/providers/connections/:connectionId/models", routeOptions, async (request, reply) => {
    try {
      const body = exact(request.body, ["connectionRevision"]);
      const connection = cloudConnection(options.database, canonicalId(request.params.connectionId), revision(body.connectionRevision));
      const adapter = new OpenAICompatibleCloudAdapter({ definitionId: connection.target.definitionId, transport: options.cloudTransport });
      const models = await withCredential(options.credentialStore, connection.credentialRef!, (key) => adapter.listModels({ credential: key }, request.signal));
      return { models: models.slice(0, MAX_MODEL_RESULTS) };
    } catch (error) { return sendError(reply, error); }
  });

  api.post<{ Params: { connectionId: string } }>("/api/providers/connections/:connectionId/test", routeOptions, async (request, reply) => {
    try {
      const body = exact(request.body, ["connectionRevision", "modelId"]);
      const connectionRevision = revision(body.connectionRevision);
      const connection = cloudConnection(options.database, canonicalId(request.params.connectionId), connectionRevision);
      const modelId = concreteModel(body.modelId, connection.target.definitionId);
      const adapter = new OpenAICompatibleCloudAdapter({ definitionId: connection.target.definitionId, transport: options.cloudTransport });
      await withCredential(options.credentialStore, connection.credentialRef!, (key) => adapter.generate({
        credential: key, model: modelId,
        messages: [{ role: "user", content: "Reply briefly to confirm this model connection." }],
        temperature: 0, maxOutputTokens: 32,
      }, request.signal));
      const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify({ definitionId: connection.target.definitionId, modelId, chat: true })).digest("hex")}`;
      observeConnection(options.database, {
        id: `observation-${randomUUID()}`,
        connection: { profileId: connection.id, revision: connection.revision },
        health: "ready", capabilityFingerprint: fingerprint,
        evidence: { chat: true },
      });
      return { status: "ready", connectionRevision, modelId, capabilityFingerprint: fingerprint };
    } catch (error) { return sendError(reply, error); }
  });

  const saveModel = (revise: boolean) => async (request: { body: unknown; params: unknown }, reply: FastifyReply) => {
    try {
      const keys = revise
        ? ["expectedRevision", "connectionId", "connectionRevision", "modelId", "temperature", "maxOutputTokens", "acknowledgedConnectionRevision"]
        : ["id", "connectionId", "connectionRevision", "modelId", "temperature", "maxOutputTokens", "acknowledgedConnectionRevision"];
      const body = exact(request.body, keys);
      const id = revise ? canonicalId((request.params as { modelProfileId: unknown }).modelProfileId) : canonicalId(body.id);
      const connectionId = canonicalId(body.connectionId);
      const connectionRevision = revision(body.connectionRevision);
      if (revision(body.acknowledgedConnectionRevision) !== connectionRevision) throw new ProviderHttpError(400, "acknowledgement_required", "Cloud disclosure acknowledgement must match the connection revision");
      const connection = cloudConnection(options.database, connectionId, connectionRevision);
      const modelId = concreteModel(body.modelId, connection.target.definitionId);
      const maxOutputTokens = revision(body.maxOutputTokens);
      if (maxOutputTokens > 32_768) throw new ProviderHttpError(400, "invalid_request", "Request body is invalid");
      const value = {
        id, revision: revise ? revision(body.expectedRevision) + 1 : 1,
        connection: { profileId: connectionId, revision: connectionRevision }, modelId,
        requiredCapabilities: ["chat"] as const,
        generation: { temperature: finiteNumber(body.temperature, 0, 2), maxOutputTokens },
      };
      const saved = revise
        ? reviseModelProfile(options.database, value, revision(body.expectedRevision))
        : createModelProfile(options.database, value);
      return reply.code(revise ? 200 : 201).send({ modelProfile: saved });
    } catch (error) { return sendError(reply, error); }
  };
  api.post("/api/providers/model-profiles", routeOptions, saveModel(false));
  api.post<{ Params: { modelProfileId: string } }>("/api/providers/model-profiles/:modelProfileId/revise", routeOptions, saveModel(true));

  api.get<{ Params: { roomId: string } }>("/api/rooms/:roomId/provider-binding", async (request, reply) => {
    const binding = readEffectiveRoomBinding(options.database, request.params.roomId);
    if (binding === undefined) return reply.code(404).send({ error: { code: "binding_missing", message: "Room has no provider binding" } });
    const model = readModelProfile(options.database, binding.model.profileId, binding.model.revision);
    return { binding, modelProfile: model };
  });

  api.post<{ Params: { roomId: string } }>("/api/rooms/:roomId/provider-binding", routeOptions, async (request, reply) => {
    try {
      const body = exact(request.body, ["id", "expectedRevision", "modelProfileId", "modelProfileRevision", "acknowledgedConnectionRevision"]);
      const expected = revision(body.expectedRevision, true);
      const modelId = canonicalId(body.modelProfileId);
      const modelRevision = revision(body.modelProfileRevision);
      const model = readCurrentModelProfile(options.database, modelId);
      if (model === undefined || model.profile.revision !== modelRevision || model.state !== "enabled") throw new ProviderHttpError(409, "revision_conflict", "Model profile revision is stale");
      if (revision(body.acknowledgedConnectionRevision) !== model.profile.connection.revision) throw new ProviderHttpError(400, "acknowledgement_required", "Cloud disclosure acknowledgement must match the connection revision");
      const value = { id: canonicalId(body.id), revision: expected + 1, roomId: request.params.roomId, purpose: "persona-default" as const, model: { profileId: modelId, revision: modelRevision } };
      const binding = expected === 0 ? bindRoom(options.database, value) : rebindRoom(options.database, value, expected);
      return reply.code(expected === 0 ? 201 : 200).send({ binding });
    } catch (error) { return sendError(reply, error); }
  });
}
