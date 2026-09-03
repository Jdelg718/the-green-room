import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import {
  parseConnectionProfile,
  parseDecisionSnapshot,
  parseModelProfile,
  parseRoomBinding,
} from "../../src/providers/profile-contracts.js";

test("connection profiles preserve an exact immutable revision without credential values", () => {
  const profile = parseConnectionProfile({
    id: "connection.primary",
    revision: 3,
    target: {
      class: "approved-provider",
      definitionId: "openai",
    },
    credentialRef: "credential:connection.primary:3",
    mutationId: "credential-replacement-3",
  });

  assert.deepEqual(profile, {
    id: "connection.primary",
    revision: 3,
    target: {
      class: "approved-provider",
      definitionId: "openai",
    },
    credentialRef: "credential:connection.primary:3",
    mutationId: "credential-replacement-3",
  });
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.target), true);
  assert.throws(() => {
    (profile as { revision: number }).revision = 4;
  }, TypeError);
});

test("model profiles bind exact connection revisions and bounded generation defaults", () => {
  const profile = parseModelProfile({
    id: "model.primary",
    revision: 5,
    connection: { profileId: "connection.primary", revision: 3 },
    modelId: "openai/gpt-5.2:preview",
    requiredCapabilities: ["chat", "system-messages"],
    generation: { temperature: 0.7, maxOutputTokens: 2048 },
  });

  assert.deepEqual(profile, {
    id: "model.primary",
    revision: 5,
    connection: { profileId: "connection.primary", revision: 3 },
    modelId: "openai/gpt-5.2:preview",
    requiredCapabilities: ["chat", "system-messages"],
    generation: { temperature: 0.7, maxOutputTokens: 2048 },
  });
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.connection), true);
  assert.equal(Object.isFrozen(profile.requiredCapabilities), true);
  assert.equal(Object.isFrozen(profile.generation), true);
});

test("model profiles accept deeply frozen cross-realm plain data", () => {
  const input = vm.runInNewContext(`Object.freeze({
    id: "model.cross-realm",
    revision: 1,
    connection: Object.freeze({ profileId: "connection.primary", revision: 1 }),
    modelId: "owner/model",
    requiredCapabilities: Object.freeze(["chat"]),
    generation: Object.freeze({ temperature: 1, maxOutputTokens: 512 })
  })`) as unknown;
  assert.deepEqual(parseModelProfile(input), {
    id: "model.cross-realm",
    revision: 1,
    connection: { profileId: "connection.primary", revision: 1 },
    modelId: "owner/model",
    requiredCapabilities: ["chat"],
    generation: { temperature: 1, maxOutputTokens: 512 },
  });
});

test("room bindings revision one room purpose to one exact model revision", () => {
  const binding = parseRoomBinding({
    id: "binding.main",
    revision: 2,
    roomId: "room.main",
    purpose: "persona-default",
    model: { profileId: "model.primary", revision: 5 },
  });

  assert.deepEqual(binding, {
    id: "binding.main",
    revision: 2,
    roomId: "room.main",
    purpose: "persona-default",
    model: { profileId: "model.primary", revision: 5 },
  });
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.model), true);
});

test("decision snapshots freeze exact non-secret profile revisions and capability evidence", () => {
  const snapshot = parseDecisionSnapshot({
    id: "decision.001",
    binding: {
      id: "binding.main",
      revision: 2,
      roomId: "room.main",
      purpose: "persona-default",
      model: { profileId: "model.primary", revision: 5 },
    },
    connection: {
      id: "connection.primary",
      revision: 3,
      target: { class: "approved-provider", definitionId: "openai" },
    },
    model: {
      id: "model.primary",
      revision: 5,
      connection: { profileId: "connection.primary", revision: 3 },
      modelId: "openai/gpt-5.2:preview",
      requiredCapabilities: ["chat", "system-messages"],
      generation: { temperature: 0.7, maxOutputTokens: 2048 },
    },
    effectiveGeneration: { temperature: 0.5, maxOutputTokens: 1024 },
    adapter: { id: "openai-compatible", version: "1.0.0" },
    capabilityFingerprint:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    directorRevision: 4,
    policyRevision: 7,
  });

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.binding), true);
  assert.equal(Object.isFrozen(snapshot.connection.target), true);
  assert.equal(Object.isFrozen(snapshot.model.requiredCapabilities), true);
  assert.equal(Object.isFrozen(snapshot.effectiveGeneration), true);
  assert.equal(Object.isFrozen(snapshot.adapter), true);
  assert.equal(JSON.stringify(snapshot).includes("credential"), false);
  assert.deepEqual(snapshot.model.connection, {
    profileId: snapshot.connection.id,
    revision: snapshot.connection.revision,
  });
  assert.deepEqual(snapshot.binding.model, {
    profileId: snapshot.model.id,
    revision: snapshot.model.revision,
  });
});

test("contracts reject every unknown own field including hidden and symbolic fields", () => {
  const base = {
    id: "connection.local",
    revision: 1,
    target: { class: "local-endpoint", adapter: "openai-compatible" },
  };
  const hidden = structuredClone(base) as Record<string, unknown>;
  Object.defineProperty(hidden, "authorization", {
    value: "Bearer sentinel",
    enumerable: false,
  });
  const symbolic = structuredClone(base) as Record<PropertyKey, unknown>;
  symbolic[Symbol("apiKey")] = "sentinel";
  const accessor = structuredClone(base) as Record<string, unknown>;
  Object.defineProperty(accessor, "revision", {
    get: () => 1,
    enumerable: true,
  });

  for (const value of [
    { ...base, endpoint: "http://127.0.0.1:1235/v1" },
    { ...base, apiKey: "sk-sentinel" },
    { ...base, headers: { authorization: "Bearer sentinel" } },
    hidden,
    symbolic,
    accessor,
    Object.assign(Object.create(null), base),
    JSON.parse(
      '{"id":"connection.local","revision":1,"target":{"class":"local-endpoint","adapter":"openai-compatible"},"__proto__":{"polluted":true}}',
    ) as unknown,
  ]) {
    assert.throws(() => parseConnectionProfile(value), TypeError);
  }
});

test("contracts reject proxies without executing any proxy trap", () => {
  const traps: ProxyHandler<Record<string, unknown>> = {};
  let trapExecutions = 0;
  for (const trap of [
    "get",
    "getOwnPropertyDescriptor",
    "getPrototypeOf",
    "has",
    "ownKeys",
  ] as const) {
    traps[trap] = (() => {
      trapExecutions += 1;
      throw new Error(`proxy ${trap} trap executed`);
    }) as never;
  }
  const proxy = new Proxy({}, traps);

  for (const parse of [
    parseConnectionProfile,
    parseModelProfile,
    parseRoomBinding,
    parseDecisionSnapshot,
  ]) {
    assert.throws(() => parse(proxy), TypeError);
  }
  assert.equal(trapExecutions, 0);
});

test("contracts require every mandatory field to be an own enumerable data property", () => {
  assert.throws(
    () =>
      parseConnectionProfile({
        revision: 1,
        target: { class: "approved-provider", definitionId: "openai" },
      }),
    TypeError,
  );

  let inheritedAccessorExecutions = 0;
  const inherited = Object.create({
    get id() {
      inheritedAccessorExecutions += 1;
      return "connection.inherited";
    },
  }) as Record<string, unknown>;
  Object.assign(inherited, {
    revision: 1,
    target: { class: "approved-provider", definitionId: "openai" },
  });

  assert.throws(() => parseConnectionProfile(inherited), TypeError);
  assert.equal(inheritedAccessorExecutions, 0);
});

test("contract rejection errors never echo untrusted field names", () => {
  const secretFieldName = "apiKey=SENTINEL_SECRET_FIELD";
  const input = {
    id: "connection.local",
    revision: 1,
    target: { class: "local-endpoint", adapter: "openai-compatible" },
    [secretFieldName]: "ignored",
    [Symbol(secretFieldName)]: "ignored",
  };

  assert.throws(
    () => parseConnectionProfile(input),
    (error: unknown) => {
      assert.equal(error instanceof TypeError, true);
      assert.equal((error as Error).message.includes(secretFieldName), false);
      return true;
    },
  );
});

test("contracts reject polluted or decorated capability arrays", () => {
  const base = {
    id: "model.strict",
    revision: 1,
    connection: { profileId: "connection.primary", revision: 1 },
    modelId: "owner/model",
    generation: { temperature: 1, maxOutputTokens: 512 },
  };
  const decorated = ["chat"];
  Object.defineProperty(decorated, "apiKey", {
    value: "sentinel",
    enumerable: false,
  });
  const polluted = ["chat"];
  Object.setPrototypeOf(polluted, Object.create(Array.prototype));

  for (const requiredCapabilities of [decorated, polluted]) {
    assert.throws(
      () => parseModelProfile({ ...base, requiredCapabilities }),
      TypeError,
    );
  }
});

test("connection targets are a closed choice between local adapters and approved providers", () => {
  assert.deepEqual(
    parseConnectionProfile({
      id: "connection.local",
      revision: 1,
      target: { class: "local-endpoint", adapter: "ollama" },
    }).target,
    { class: "local-endpoint", adapter: "ollama" },
  );
  for (const target of [
    { class: "approved-provider", definitionId: "unreviewed-cloud" },
    { class: "local-endpoint", adapter: "custom", url: "http://localhost:9999" },
    { class: "custom-endpoint", url: "https://example.test/v1" },
  ]) {
    assert.throws(
      () =>
        parseConnectionProfile({
          id: "connection.invalid",
          revision: 1,
          target,
        }),
      TypeError,
    );
  }
});

test("profile identifiers, revisions, capabilities, and numeric generation options are bounded", () => {
  for (const id of ["", "UPPER", "leading space", "a/b", "a..b", "x".repeat(129)]) {
    assert.throws(
      () =>
        parseConnectionProfile({
          id,
          revision: 1,
          target: { class: "approved-provider", definitionId: "openai" },
        }),
      /canonical ID/,
    );
  }
  for (const revision of [0, -1, 1.5, 2_147_483_648]) {
    assert.throws(
      () =>
        parseConnectionProfile({
          id: "connection.invalid",
          revision,
          target: { class: "approved-provider", definitionId: "openai" },
        }),
      /revision/,
    );
  }
  for (const mutationId of ["", "UPPER", "with_underscore", "x".repeat(129)]) {
    assert.throws(
      () => parseConnectionProfile({
        id: "connection.invalid",
        revision: 1,
        target: { class: "approved-provider", definitionId: "openai" },
        mutationId,
      }),
      /mutationId/,
    );
  }

  const modelBase = {
    id: "model.bounded",
    revision: 1,
    connection: { profileId: "connection.primary", revision: 1 },
    modelId: "owner/model",
    requiredCapabilities: ["chat"],
    generation: { temperature: 1, maxOutputTokens: 512 },
  };
  for (const modelId of [
    "https://opaque.example/model",
    "owner//opaque",
    "owner/../opaque",
    "owner\\opaque",
    "/leading/slash",
    "provider:model:variant",
  ]) {
    assert.equal(parseModelProfile({ ...modelBase, modelId }).modelId, modelId);
  }
  for (const modelId of [
    "",
    " owner/model",
    "owner/model ",
    "owner model",
    "owner/model\nsecret",
    "owner/model\u0085secret",
    "owner/model\u00a0secret",
    "owner/model\u2028secret",
    "owner/e\u0301",
    "é".repeat(129),
  ]) {
    assert.throws(() => parseModelProfile({ ...modelBase, modelId }), /modelId/);
  }
  for (const generation of [
    { temperature: -0.1, maxOutputTokens: 512 },
    { temperature: 2.1, maxOutputTokens: 512 },
    { temperature: Number.NaN, maxOutputTokens: 512 },
    { temperature: 1, maxOutputTokens: 0 },
    { temperature: 1, maxOutputTokens: 32_769 },
    { temperature: 1, maxOutputTokens: 1.5 },
  ]) {
    assert.throws(() => parseModelProfile({ ...modelBase, generation }), TypeError);
  }
  for (const requiredCapabilities of [
    ["system-messages", "chat"],
    ["chat", "chat"],
    ["chat", "tools"],
  ]) {
    assert.throws(
      () => parseModelProfile({ ...modelBase, requiredCapabilities }),
      /capabilit/i,
    );
  }
});

function validDecisionInput(): Record<string, unknown> {
  return {
    id: "decision.valid",
    binding: {
      id: "binding.main",
      revision: 2,
      roomId: "room.main",
      purpose: "persona-default",
      model: { profileId: "model.primary", revision: 5 },
    },
    connection: {
      id: "connection.primary",
      revision: 3,
      target: { class: "approved-provider", definitionId: "openai" },
    },
    model: {
      id: "model.primary",
      revision: 5,
      connection: { profileId: "connection.primary", revision: 3 },
      modelId: "openai/gpt-5.2:preview",
      requiredCapabilities: ["chat", "system-messages"],
      generation: { temperature: 0.7, maxOutputTokens: 2048 },
    },
    effectiveGeneration: { temperature: 0.5, maxOutputTokens: 1024 },
    adapter: { id: "openai-compatible", version: "1.0.0" },
    capabilityFingerprint:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    directorRevision: 4,
    policyRevision: 7,
  };
}

test("decision snapshots reject credentials, stale revision links, and noncanonical evidence", () => {
  const credential = validDecisionInput();
  (credential.connection as Record<string, unknown>).credentialRef =
    "credential:connection.primary";
  const authorization = validDecisionInput();
  (authorization.adapter as Record<string, unknown>).authorization = "Bearer sentinel";
  const staleConnection = validDecisionInput();
  ((staleConnection.model as Record<string, unknown>).connection as Record<
    string,
    unknown
  >).revision = 2;
  const staleModel = validDecisionInput();
  ((staleModel.binding as Record<string, unknown>).model as Record<
    string,
    unknown
  >).revision = 4;
  const badFingerprint = validDecisionInput();
  badFingerprint.capabilityFingerprint = "sha256:ABC";
  const badVersion = validDecisionInput();
  (badVersion.adapter as Record<string, unknown>).version = "latest";
  const leadingZeroPrerelease = validDecisionInput();
  (leadingZeroPrerelease.adapter as Record<string, unknown>).version = "1.0.0-01";

  for (const input of [
    credential,
    authorization,
    staleConnection,
    staleModel,
    badFingerprint,
    badVersion,
    leadingZeroPrerelease,
  ]) {
    assert.throws(() => parseDecisionSnapshot(input), TypeError);
  }
});

test("all approved cloud connection targets map only to openai-compatible evidence", () => {
  for (const definitionId of ["openrouter", "openai", "xai", "groq", "together"] as const) {
    const input = validDecisionInput();
    (input.connection as Record<string, unknown>).target = {
      class: "approved-provider",
      definitionId,
    };
    assert.equal(parseDecisionSnapshot(input).adapter.id, "openai-compatible");
  }
  assert.throws(() => parseConnectionProfile({
    id: "connection.anthropic",
    revision: 1,
    target: { class: "approved-provider", definitionId: "anthropic" },
  }), /not approved/);
});

test("decision snapshot adapter evidence must match every closed connection target", () => {
  const mismatches = [
    {
      target: { class: "approved-provider", definitionId: "openai" },
      adapterId: "anthropic",
    },
    {
      target: { class: "approved-provider", definitionId: "anthropic" },
      adapterId: "openai-compatible",
      expected: /approved/i,
    },
    {
      target: { class: "local-endpoint", adapter: "ollama" },
      adapterId: "openai-compatible",
    },
    {
      target: { class: "local-endpoint", adapter: "openai-compatible" },
      adapterId: "ollama",
    },
  ];

  for (const { target, adapterId, expected = /adapter/i } of mismatches) {
    const input = validDecisionInput();
    (input.connection as Record<string, unknown>).target = target;
    (input.adapter as Record<string, unknown>).id = adapterId;
    assert.throws(() => parseDecisionSnapshot(input), expected);
  }
});
