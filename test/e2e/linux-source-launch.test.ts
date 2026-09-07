import assert from "node:assert/strict";
import { spawn, execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const MODEL = "anthropic/claude-3.5-sonnet";
const launcher = fileURLToPath(new URL("../../../scripts/start-linux.mjs", import.meta.url));
const transportHook = fileURLToPath(new URL("../../../test/fixtures/linux-source-cloud-transport.mjs", import.meta.url));
const PROVIDER_KEY_NAMES = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "GROQ_API_KEY", "TOGETHER_API_KEY"] as const;

function launcherEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--import=${transportHook}` };
  for (const name of PROVIDER_KEY_NAMES) delete environment[name];
  return environment;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test("Linux source launcher refuses provider keys in environment variables and all command-line arguments", () => {
  const secret = randomBytes(24).toString("hex");
  const environmentAttempt = spawnSync(process.execPath, [launcher], {
    cwd: tmpdir(),
    env: { ...launcherEnvironment(), OPENROUTER_API_KEY: secret },
    encoding: "utf8",
  });
  assert.equal(environmentAttempt.status, 1);
  assert.match(environmentAttempt.stderr, /OPENROUTER_API_KEY is not accepted/);
  assert.equal(`${environmentAttempt.stdout}${environmentAttempt.stderr}`.includes(secret), false);

  const argumentAttempt = spawnSync(process.execPath, [launcher, `--provider-key=${secret}`], {
    cwd: tmpdir(),
    env: launcherEnvironment(),
    encoding: "utf8",
  });
  assert.equal(argumentAttempt.status, 1);
  assert.match(argumentAttempt.stderr, /accepts no arguments/);
  assert.equal(`${argumentAttempt.stdout}${argumentAttempt.stderr}`.includes(secret), false);
});

test("Linux source launcher runs from a foreign cwd and persists an offline mocked OpenRouter reply", { timeout: 30_000 }, async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "green-room-linux-launch-")));
  const foreignCwd = join(root, "foreign-cwd");
  const dataDir = join(root, "data");
  const tlsRoot = join(root, "tls");
  mkdirSync(foreignCwd);
  mkdirSync(tlsRoot);
  const configPath = join(tlsRoot, "openssl.cnf");
  const caKeyPath = join(tlsRoot, "ca-key.pem");
  const caPath = join(tlsRoot, "ca-cert.pem");
  const keyPath = join(tlsRoot, "server-key.pem");
  const requestPath = join(tlsRoot, "server.csr");
  const certificatePath = join(tlsRoot, "server-cert.pem");
  writeFileSync(configPath, [
    "[req]", "distinguished_name=dn", "req_extensions=v3", "prompt=no", "[dn]", "CN=openrouter.ai",
    "[v3]", "subjectAltName=DNS:openrouter.ai", "keyUsage=digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth", "",
  ].join("\n"));
  const openssl = { cwd: root, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: "ignore", timeout: 10_000 } as const;
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=Green Room Linux Source Test CA", "-keyout", caKeyPath, "-out", caPath], openssl);
  execFileSync("/usr/bin/openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", keyPath, "-out", requestPath, "-config", configPath], openssl);
  execFileSync("/usr/bin/openssl", ["x509", "-req", "-sha256", "-days", "1", "-in", requestPath, "-CA", caPath, "-CAkey", caKeyPath, "-CAcreateserial", "-out", certificatePath, "-extfile", configPath, "-extensions", "v3"], openssl);

  const requests: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  const fixture = createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization });
      const payload = request.method === "GET"
        ? { data: [{ id: MODEL }] }
        : { model: JSON.parse(body).model, choices: [{ message: { content: "Offline launcher fixture reply." } }] };
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  });
  const fixtureAddress = fixture.address();
  assert.ok(fixtureAddress !== null && typeof fixtureAddress !== "string");

  const appPort = await availablePort();
  const origin = `http://127.0.0.1:${appPort}`;
  const output: Buffer[] = [];
  let child: ChildProcess | undefined;
  const start = async () => {
    const launched = spawn(process.execPath, [launcher], {
      cwd: foreignCwd,
      env: {
        ...launcherEnvironment(),
        GREENROOM_DATA_DIR: dataDir,
        GREENROOM_HOST: "127.0.0.1",
        GREENROOM_PORT: String(appPort),
        GREENROOM_PERSONA_INSPECTION: "disabled",
        GREENROOM_TEST_OPENROUTER_PORT: String(fixtureAddress.port),
        GREENROOM_TEST_OPENROUTER_CA: caPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = launched;
    launched.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    launched.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && launched.exitCode === null) {
      try {
        const health = await fetch(`${origin}/health`);
        if (health.status === 200 && (await health.json() as { status: string }).status === "ok") return launched;
      } catch { /* startup is still in progress */ }
      await delay(25);
    }
    assert.fail(`Linux launcher did not become ready:\n${Buffer.concat(output).toString("utf8")}`);
  };
  context.after(async () => {
    if (child !== undefined) await stop(child);
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const mutate = async (csrf: string, url: string, payload: Record<string, unknown>) => {
    const response = await fetch(`${origin}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "x-csrf-token": csrf },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    assert.ok(response.ok, `${url}: ${response.status} ${body}`);
    return JSON.parse(body) as Record<string, any>;
  };

  await start();
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as {
    csrfToken: string;
    capabilities: { providerSetup: { cloud: boolean } };
  };
  assert.equal(bootstrap.capabilities.providerSetup.cloud, true);
  assert.match(Buffer.concat(output).toString("utf8"), new RegExp(`Green Room: ${origin.replaceAll(".", "\\.")}`));
  const secret = randomBytes(24).toString("hex");
  await mutate(bootstrap.csrfToken, "/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: secret, acknowledgedConnectionRevision: 1,
  });
  assert.deepEqual((await mutate(bootstrap.csrfToken, "/api/providers/connections/openrouter-main/models", { connectionRevision: 1 })).models, [MODEL]);
  assert.equal((await mutate(bootstrap.csrfToken, "/api/providers/connections/openrouter-main/test", { connectionRevision: 1, modelId: MODEL })).status, "ready");
  const profile = await mutate(bootstrap.csrfToken, "/api/providers/model-profiles", {
    id: "openrouter-room-model", connectionId: "openrouter-main", connectionRevision: 1,
    modelId: MODEL, temperature: 0.4, maxOutputTokens: 256, acknowledgedConnectionRevision: 1,
  });
  await mutate(bootstrap.csrfToken, "/api/rooms/first-playable/provider-binding", {
    id: "first-playable-provider", expectedRevision: 0,
    modelProfileId: profile.modelProfile.profile.id, modelProfileRevision: profile.modelProfile.profile.revision,
    acknowledgedConnectionRevision: 1,
  });
  const reply = await mutate(bootstrap.csrfToken, "/api/rooms/first-playable/messages", {
    requestId: "linux-source-before-restart", selectionRevision: 0,
    text: "Reply through the offline fixture.", wantsResponse: true,
  });
  assert.equal(reply.outcome, "text");
  assert.equal(JSON.stringify(reply).includes(secret), false);
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: "GET", url: "/api/v1/models" },
    { method: "POST", url: "/api/v1/chat/completions" },
    { method: "POST", url: "/api/v1/chat/completions" },
  ]);
  assert.equal(requests.every((request) => request.authorization === `Bearer ${secret}`), true);
  const credentialPath = join(dataDir, "credentials/credential:openrouter-main:1");
  assert.equal(lstatSync(join(dataDir, "credentials")).mode & 0o777, 0o700);
  assert.equal(lstatSync(credentialPath).mode & 0o777, 0o600);

  await stop(child!);
  child = undefined;
  await start();
  const restartedBootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { csrfToken: string; capabilities: { providerSetup: { cloud: boolean } } };
  assert.equal(restartedBootstrap.capabilities.providerSetup.cloud, true);
  const connections = await (await fetch(`${origin}/api/providers/connections`)).json() as { connections: Array<{ id: string; credentialStatus: string }> };
  assert.deepEqual(connections.connections.map(({ id, credentialStatus }) => ({ id, credentialStatus })), [{ id: "openrouter-main", credentialStatus: "stored" }]);
  const events = await (await fetch(`${origin}/api/rooms/first-playable/events?after=0`)).json() as { events: Array<{ event: { type: string; text?: string } }> };
  assert.equal(events.events.some(({ event }) => event.type === "persona_message" && event.text === "Offline launcher fixture reply."), true);
  assert.equal(existsSync(join(dataDir, "greenroom.sqlite")), true);
  assert.equal(readFileSync(join(dataDir, "greenroom.sqlite")).includes(Buffer.from(secret)), false);
  assert.equal(Buffer.concat(output).includes(Buffer.from(secret)), false);
});
