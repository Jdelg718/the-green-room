import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  CLOUD_TRANSPORT_TIMEOUT,
  CloudProviderError,
  OpenAICompatibleCloudAdapter,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "../../src/providers/openai-compatible-cloud.js";
import {
  APPROVED_CLOUD_PROVIDER_IDS,
  getProviderDefinition,
  parseProviderModels,
  type ApprovedCloudProviderId,
  type ModelParser,
  type OutputTokenField,
} from "../../src/providers/provider-definitions.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const credential = "ISSUE133_MOCK_CREDENTIAL_NEVER_NETWORKED";

type Contract = Readonly<{
  hostname: string;
  basePath: string;
  outputTokenField: OutputTokenField;
  modelParser: ModelParser;
  model: string;
}>;

const CONTRACTS: Readonly<Record<ApprovedCloudProviderId, Contract>> = Object.freeze({
  openrouter: Object.freeze({ hostname: "openrouter.ai", basePath: "/api/v1", outputTokenField: "max_tokens", modelParser: "data-id", model: "anthropic/claude-3.5-sonnet" }),
  openai: Object.freeze({ hostname: "api.openai.com", basePath: "/v1", outputTokenField: "max_completion_tokens", modelParser: "data-id", model: "gpt-4.1-mini" }),
  xai: Object.freeze({ hostname: "api.x.ai", basePath: "/v1", outputTokenField: "max_tokens", modelParser: "data-id", model: "grok-3-mini" }),
  groq: Object.freeze({ hostname: "api.groq.com", basePath: "/openai/v1", outputTokenField: "max_completion_tokens", modelParser: "data-id", model: "llama-3.3-70b-versatile" }),
  together: Object.freeze({ hostname: "api.together.ai", basePath: "/v1", outputTokenField: "max_tokens", modelParser: "array-id", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }),
});

function response(body: unknown, status = 200, contentType = "application/json"): CloudTransportResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({ "content-type": contentType }),
    body: encoder.encode(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

function catalog(contract: Contract): unknown {
  const list = [{ id: contract.model }];
  return contract.modelParser === "data-id" ? { data: list } : list;
}

function mockTransport(replies: readonly (CloudTransportResponse | unknown)[]) {
  const calls: CloudTransportRequest[] = [];
  let index = 0;
  const transport: CloudTransport = {
    request(request) {
      calls.push(request);
      const reply = replies[index++];
      return reply instanceof Error || reply === CLOUD_TRANSPORT_TIMEOUT
        ? Promise.reject(reply)
        : Promise.resolve(reply as CloudTransportResponse);
    },
  };
  return { calls, transport };
}

function code(expected: CloudProviderError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof CloudProviderError
    && error.code === expected
    && !String(error).includes(credential)
    && !Object.hasOwn(error, "cause");
}

test("the shared approved-cloud matrix pins exact endpoint, parser, auth, body, and token contracts", async () => {
  assert.deepEqual(APPROVED_CLOUD_PROVIDER_IDS, ["openrouter", "openai", "xai", "groq", "together"]);
  for (const id of APPROVED_CLOUD_PROVIDER_IDS) {
    const expected = CONTRACTS[id];
    const definition = getProviderDefinition(id);
    assert.deepEqual(definition, {
      id,
      version: 1,
      adapter: "openai-compatible",
      scheme: "https",
      hostname: expected.hostname,
      port: 443,
      basePath: expected.basePath,
      modelsPath: `${expected.basePath}/models`,
      chatPath: `${expected.basePath}/chat/completions`,
      authorization: { scheme: "Bearer", header: "authorization" },
      outputTokenField: expected.outputTokenField,
      modelParser: expected.modelParser,
    });
    assert.deepEqual(parseProviderModels(id, catalog(expected)), [expected.model]);

    const mock = mockTransport([
      response(catalog(expected)),
      response({ model: expected.model, choices: [{ message: { content: "Mocked provider reply." } }] }),
    ]);
    const adapter = new OpenAICompatibleCloudAdapter({ definitionId: id, transport: mock.transport });
    assert.deepEqual(await adapter.listModels({ credential }, new AbortController().signal), [expected.model]);
    assert.deepEqual(await adapter.generate({
      credential,
      model: expected.model,
      messages: [{ role: "system", content: "Use one sentence." }, { role: "user", content: "Say ready." }],
      temperature: 0,
      maxOutputTokens: 16,
    }, new AbortController().signal), { kind: "text", text: "Mocked provider reply." });

    assert.equal(mock.calls.length, 2);
    assert.deepEqual(mock.calls[0], {
      definitionId: id,
      scheme: "https",
      hostname: expected.hostname,
      port: 443,
      method: "GET",
      path: `${expected.basePath}/models`,
      headers: { accept: "application/json", authorization: `Bearer ${credential}` },
    });
    const chat = mock.calls[1]!;
    assert.deepEqual({ ...chat, body: JSON.parse(decoder.decode(chat.body)) }, {
      definitionId: id,
      scheme: "https",
      hostname: expected.hostname,
      port: 443,
      method: "POST",
      path: `${expected.basePath}/chat/completions`,
      headers: { accept: "application/json", authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: {
        model: expected.model,
        messages: [{ role: "system", content: "Use one sentence." }, { role: "user", content: "Say ready." }],
        temperature: 0,
        [expected.outputTokenField]: 16,
        stream: false,
        ...(id === "openrouter" ? { provider: { allow_fallbacks: false } } : {}),
      },
    });
  }
});

test("all approved providers, including OpenRouter, share sanitized malformed/error/cancel/timeout/model-mismatch behavior", async () => {
  for (const id of APPROVED_CLOUD_PROVIDER_IDS) {
    const expected = CONTRACTS[id];
    const input = {
      credential,
      model: expected.model,
      messages: [{ role: "user" as const, content: "Say ready." }],
      temperature: 0,
      maxOutputTokens: 8,
    };
    for (const [reply, expectedCode] of [
      [response("{malformed"), "invalid_response"],
      [response({ error: { message: credential } }, 429), "provider_failure"],
      [CLOUD_TRANSPORT_TIMEOUT, "timeout"],
      [response({ model: `${expected.model}-mismatch`, choices: [{ message: { content: credential } }] }), "invalid_response"],
    ] as const) {
      const mock = mockTransport([reply]);
      const adapter = new OpenAICompatibleCloudAdapter({ definitionId: id, transport: mock.transport });
      await assert.rejects(adapter.generate(input, new AbortController().signal), code(expectedCode));
      assert.equal(mock.calls.length, 1);
    }

    const canceled = new AbortController();
    canceled.abort();
    const mock = mockTransport([]);
    const adapter = new OpenAICompatibleCloudAdapter({ definitionId: id, transport: mock.transport });
    await assert.rejects(adapter.generate(input, canceled.signal), code("canceled"));
    assert.equal(mock.calls.length, 0, `${id} contacted transport after cancellation`);

    const malformedCatalog = expected.modelParser === "data-id" ? [{ id: expected.model }] : { data: [{ id: expected.model }] };
    assert.throws(() => parseProviderModels(id, malformedCatalog), /invalid/i);
  }
});

test("all five definitions behaviorally reject unsupported request fields and features before transport", async () => {
  const unsupported = [
    ["stream", true],
    ["tools", [{ type: "function" }]],
    ["media", [{ type: "image" }]],
    ["search", true],
    ["fallback", true],
    ["responseFormat", { type: "json_object" }],
  ] as const;
  for (const id of APPROVED_CLOUD_PROVIDER_IDS) {
    const expected = CONTRACTS[id];
    for (const [field, value] of unsupported) {
      const mock = mockTransport([]);
      const adapter = new OpenAICompatibleCloudAdapter({ definitionId: id, transport: mock.transport });
      await assert.rejects(adapter.generate({
        credential,
        model: expected.model,
        messages: [{ role: "user", content: "Say ready." }],
        temperature: 0,
        maxOutputTokens: 8,
        [field]: value,
      }, new AbortController().signal), code("invalid_request"), `${id} accepted unsupported ${field}`);
      assert.equal(mock.calls.length, 0, `${id} contacted transport for unsupported ${field}`);
    }
    const listMock = mockTransport([]);
    const adapter = new OpenAICompatibleCloudAdapter({ definitionId: id, transport: listMock.transport });
    await assert.rejects(adapter.listModels({ credential, features: ["tools"] } as never, new AbortController().signal), code("invalid_request"));
    assert.equal(listMock.calls.length, 0, `${id} contacted transport for unsupported model-list features`);
  }
});

test("live smoke kills timed-out subprocess groups and preserves a substituted temporary root", {
  skip: process.platform !== "darwin",
}, () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "greenroom-live-smoke-contract-"));
  try {
    const marker = join(fixtureRoot, "escaped-descendant-marker");
    const timeoutProbe = String.raw`
import { runFrozen } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/smoke-provider-live.mjs")).href)};
try {
  runFrozen("/usr/bin/python3", ["-c", ${JSON.stringify("import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',\"import pathlib,sys,time; time.sleep(0.6); pathlib.Path(sys.argv[1]).write_text('escaped')\",sys.argv[1]]); time.sleep(10)")}, ${JSON.stringify(marker)}], process.cwd(), { PATH: "/usr/bin:/bin", LANG: "C" }, 100);
} catch { process.stdout.write("timed-out-safely\n"); }
`;
    const timeoutResult = spawnSync(process.execPath, ["--input-type=module", "--eval", timeoutProbe], {
      cwd: process.cwd(), env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(timeoutResult.status, 0);
    assert.equal(timeoutResult.stdout, "timed-out-safely\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
    assert.equal(existsSync(marker), false, "a timed-out grandchild survived its process group");

    const cleanupProbe = String.raw`
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupRoot } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/smoke-provider-live.mjs")).href)};
const parent = mkdtempSync("/private/tmp/greenroom-live-smoke-cleanup-contract-");
const target = join(parent, "target"); const original = join(parent, "original");
mkdirSync(target, { mode: 0o700 }); const identity = lstatSync(target); renameSync(target, original);
mkdirSync(target, { mode: 0o700 }); writeFileSync(join(target, "competitor"), "preserve");
let code = "none"; try { cleanupRoot(target, identity); } catch (error) { code = error.code; }
const preserved = lstatSync(join(target, "competitor")).isFile();
rmSync(parent, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ code, preserved }) + "\n");
`;
    const cleanupResult = spawnSync(process.execPath, ["--input-type=module", "--eval", cleanupProbe], {
      cwd: process.cwd(), env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(cleanupResult.status, 0);
    assert.deepEqual(JSON.parse(cleanupResult.stdout), { code: "live_smoke_cleanup_identity", preserved: true });
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
});

test("acceptance process runner bounds an undrained process-listing pipe and reaps the child", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "greenroom-acceptance-runner-contract-"));
  try {
    const orchestrator = readFileSync("scripts/accept-provider-milestone.mjs", "utf8");
    const runner = orchestrator.match(/const PROCESS_GROUP_RUNNER = String\.raw`\n([\s\S]*?)\n`;/u)?.[1];
    assert.ok(runner, "process-group runner source was unavailable");
    const runnerPath = join(fixtureRoot, "runner.py");
    const childPath = join(fixtureRoot, "undrained.mjs");
    const signalPath = join(fixtureRoot, "ready");
    const pidPath = join(fixtureRoot, "pid");
    writeFileSync(runnerPath, runner, { mode: 0o400 });
    writeFileSync(childPath, [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.env.PID_FILE, String(process.pid));',
      'writeFileSync(process.env.GREENROOM_PROVIDER_ACCEPTANCE_PROCESS_LISTING_SIGNAL, "ready", { flag: "wx", mode: 0o600 });',
      'setTimeout(() => {}, 10_000);',
    ].join("\n"), { mode: 0o400 });
    const result = spawnSync("/usr/bin/python3", [runnerPath, "0.25", "capture", process.execPath, childPath], {
      cwd: fixtureRoot,
      env: { PATH: "/usr/bin:/bin", PID_FILE: pidPath, GREENROOM_PROVIDER_ACCEPTANCE_PROCESS_LISTING_SIGNAL: signalPath },
      encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 124, "undrained listing pipe did not time out within its shared deadline");
    const pid = Number(readFileSync(pidPath, "utf8"));
    assert.equal(Number.isSafeInteger(pid) && pid > 1, true);
    assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
});

test("issue 133 acceptance entrypoints and operator records are present and fail-closed by contract", () => {
  const required = [
    "scripts/accept-provider-milestone.mjs",
    "scripts/smoke-provider-live.mjs",
    "docs/runbooks/provider-live-smoke.md",
    "docs/acceptance/provider-milestone.md",
  ] as const;
  for (const path of required) accessSync(path);
  const orchestrator = readFileSync(required[0], "utf8");
  assert.match(orchestrator, /NODE_RUNTIME_ARCHIVE/);
  assert.match(orchestrator, /node-v24\.20\.0-darwin-arm64\.tar\.gz/);
  assert.match(orchestrator, /process\.version !== "v24\.20\.0"/);
  assert.match(orchestrator, /npmVersion !== "11\.19\.0"/);
  assert.doesNotMatch(orchestrator, /npm_execpath/);
  assert.match(orchestrator, /focused_test_selection_empty/);
  assert.match(orchestrator, /candidate-clean-status/);
  assert.match(orchestrator, /macos-sandbox-deny-non-loopback/);
  assert.match(orchestrator, /SAFE_PARENT_ENV = Object\.freeze\(\["LANG", "LC_ALL", "TERM"\]\)/);
  assert.match(orchestrator, /HOME: join\(acceptanceRoot, "child-home"\), TMPDIR: trustedParentTmpdir\(\)/);
  assert.match(orchestrator, /identity\.uid !== process\.getuid\(\)/);
  assert.match(orchestrator, /npm_config_cache: trustedNpmCache\(\)/);
  assert.match(orchestrator, /npm_config_devdir: trustedNodeGypCache\(\)/);
  assert.match(orchestrator, /frozen-locked-dependencies/);
  assert.match(orchestrator, /frozen-source-post-install-status/);
  assert.match(orchestrator, /cleanupRoot\(root, rootIdentity\)/);
  assert.match(orchestrator, /exactKeys\(task13/);
  assert.match(orchestrator, /exactKeys\(evidence/);
  assert.match(orchestrator, /packaged_runtime_acceptance_ok/);
  assert.match(orchestrator, /candidate-mode-not-run/);
  assert.match(orchestrator, /signing[^\n]+pending/i);
  assert.match(orchestrator, /notarization[^\n]+pending/i);
  assert.match(orchestrator, /clean-standard-user[^\n]+pending/i);
  assert.match(orchestrator, /final-checksums/);
  assert.match(orchestrator, /artifact-and-sbom-attestations/);
  assert.match(orchestrator, /backup-migration-restore-rollback-uninstall-reinstall-purge/);
  const smoke = readFileSync(required[1], "utf8");
  assert.match(smoke, /LIVE_PROVIDER_SMOKE_ACK/);
  assert.match(smoke, /process\.stdin\.isTTY/);
  assert.match(smoke, /process\.version !== "v24\.20\.0"/);
  assert.match(smoke, /realpathSync\(process\.cwd\(\)\)/);
  assert.match(smoke, /clone", "--local", "--no-hardlinks", "--no-checkout"/);
  assert.match(smoke, /"ci", "--offline", "--strict-allow-scripts=true"/);
  assert.match(smoke, /identity\.nlink !== 1/);
  assert.match(smoke, /npm_config_cache: npmCache/);
  assert.match(smoke, /npm_config_devdir: nodeGypCache/);
  assert.match(smoke, /Reply with one word: ready/);
  assert.doesNotMatch(smoke, /OPENAI_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY|GROQ_API_KEY|TOGETHER_API_KEY/);
  const spawnSmoke = (args: string[], env: Record<string, string>, cwd = process.cwd()) => spawnSync(process.execPath, [required[1], ...args], {
    cwd, env, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
  });
  const skipped = spawnSync(process.execPath, [required[1]], {
    cwd: process.cwd(),
    env: { PATH: "/nonexistent" },
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  assert.equal(skipped.status, 0);
  assert.deepEqual(JSON.parse(skipped.stdout), {
    provider: "unselected",
    model: "unselected",
    status: "SKIPPED",
  });
  assert.equal(skipped.stderr, "");

  const failures = [
    spawnSmoke([], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "wrong" }),
    spawnSmoke([], { PATH: "/nonexistent", CI: "1", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=unknown", "--model=x"], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=openrouter", "--model=openrouter/auto"], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=openai", "--model=sk-proj-THIS_MUST_NEVER_BE_ECHOED_1234567890"], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=groq", "--model=credential=THIS_MUST_NEVER_BE_ECHOED"], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=groq", "--model=gsk_AAAAAAAAAAAAAAAAAAAAAAAA"], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=xai", "--model=xai-AAAAAAAAAAAAAAAAAAAAAAAA"], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=openrouter", "--model=sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAA"], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=together", "--model=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=openai", "--model=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB+AAA"], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=together", "--model=unsafe💥model"], { PATH: "/nonexistent", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
    spawnSmoke(["--provider=openrouter", "--model=anthropic/claude-3.5-sonnet"], { PATH: "/nonexistent", NODE_DEBUG: "http", LIVE_PROVIDER_SMOKE_ACK: "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY" }),
  ];
  for (const result of failures) {
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { provider: "unselected", model: "unselected", status: "failed" });
    assert.equal(result.stderr, "");
  }
});
