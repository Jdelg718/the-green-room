import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync,
} from "node:fs";
import { createServer, request as realHttpsRequest } from "node:https";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect as realTlsConnect, type TLSSocket } from "node:tls";
import { test } from "node:test";

const HOST = "127.0.0.1:8787";
const ORIGIN = `http://${HOST}`;
const MODEL = "anthropic/claude-3.5-sonnet";
const SECRET = "ISSUE133_PACKAGED_FAKE_KEYCHAIN_SECRET+/=?%";
const GLOBAL_FIXTURE_ADDRESS = "93.184.216.34";

type Runtime = {
  app: { ready(): Promise<void>; close(): Promise<void>; inject(input: Record<string, unknown>): Promise<{ statusCode: number; body: string; json<T = any>(): T }> };
  closeDatabase(): void;
  mutate(url: string, payload: Record<string, unknown>): Promise<Record<string, any>>;
  query(sql: string): readonly unknown[];
};

function sha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function strictChild(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep);
}
function regularFilesRecursively(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name); const identity = lstatSync(path);
    if (identity.isDirectory() && !identity.isSymbolicLink()) files.push(...regularFilesRecursively(path));
    else if (identity.isFile() && !identity.isSymbolicLink()) files.push(path);
  }
  return files;
}
function sentinelForms(secret: string): readonly Buffer[] {
  return Object.freeze([
    Buffer.from(secret, "utf8"), Buffer.from(Buffer.from(secret).toString("base64"), "utf8"),
    Buffer.from(Buffer.from(secret).toString("base64url"), "utf8"), Buffer.from(Buffer.from(secret).toString("hex"), "utf8"),
    Buffer.from(encodeURIComponent(secret), "utf8"),
  ]);
}
function assertSurfaceClean(surface: string, values: readonly Buffer[], sentinels: readonly Buffer[]): void {
  for (const value of values) for (const sentinel of sentinels) {
    assert.equal(value.includes(sentinel), false, `credential sentinel audit failed for ${surface}`);
  }
}
function writeFakeHelper(root: string): string {
  const helper = join(root, "helpers", "GreenRoomCredentialHelper");
  const state = join(root, "fake-keychain.json");
  mkdirSync(dirname(helper), { recursive: true, mode: 0o700 });
  writeFileSync(helper, `#!/usr/bin/python3
import json, os, struct, sys
state_path = ${JSON.stringify(state)}
header = sys.stdin.buffer.read(4)
if len(header) != 4: sys.exit(70)
size = struct.unpack(">I", header)[0]
request = json.loads(sys.stdin.buffer.read(size).decode("utf-8"))
try:
    with open(state_path, "r", encoding="utf-8") as handle: values = json.load(handle)
except FileNotFoundError: values = {}
account = request["account"]
operation = request["operation"]
response = {"version": 1, "status": "ok"}
if operation == "put":
    if account in values: response["status"] = "duplicate"
    else: values[account] = request["secret"]
elif operation == "replace": values[account] = request["secret"]
elif operation == "get":
    if account not in values: response["status"] = "missing"
    else: response["secret"] = values[account]
elif operation == "delete":
    if account not in values: response["status"] = "missing"
    else: del values[account]
if operation in ("put", "replace", "delete") and response["status"] == "ok":
    temporary = state_path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle: json.dump(values, handle, sort_keys=True)
    os.replace(temporary, state_path)
payload = json.dumps(response, separators=(",", ":")).encode("utf-8")
sys.stdout.buffer.write(struct.pack(">I", len(payload)) + payload)
`, { mode: 0o500 });
  chmodSync(helper, 0o500);
  return realpathSync(helper);
}

test("exact packaged OpenRouter flow uses bundled Node and a real loopback TLS fixture", {
  skip: process.env.GREENROOM_PROVIDER_ACCEPTANCE_APP === undefined ? "set by the provider milestone orchestrator" : false,
  timeout: 60_000,
}, async (context) => {
  const ownedHarnessRoot = realpathSync(process.env.GREENROOM_PROVIDER_ACCEPTANCE_CWD!);
  const scratch = realpathSync(mkdtempSync(join(ownedHarnessRoot, "scratch-")));
  let runtime: Runtime | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  context.after(async () => {
    if (runtime !== undefined) {
      const closing = runtime; runtime = undefined;
      try { await closing.app.close(); } catch { /* cleanup preserves the original test failure */ } finally { closing.closeDatabase(); }
    }
    if (server !== undefined) {
      server.closeAllConnections(); await new Promise<void>((done) => server!.close(() => done())); server = undefined;
    }
    // The orchestrator atomically cleans its identity-bound root after this harness exits.
  });

  const appRoot = realpathSync(process.env.GREENROOM_PROVIDER_ACCEPTANCE_APP!);
  const bundledNode = realpathSync(process.env.GREENROOM_PROVIDER_ACCEPTANCE_NODE!);
  const externalHarness = realpathSync(process.env.GREENROOM_PROVIDER_ACCEPTANCE_HARNESS!);
  assert.equal(realpathSync(process.execPath), bundledNode);
  assert.equal(realpathSync(fileURLToPath(import.meta.url)), externalHarness);
  assert.equal(strictChild(appRoot, bundledNode), true);
  assert.equal(strictChild(appRoot, externalHarness), false);
  assert.equal(process.version, "v24.20.0");
  assert.equal(process.cwd(), realpathSync(process.env.GREENROOM_PROVIDER_ACCEPTANCE_CWD!));
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.equal(process.env.NODE_PATH, undefined);
  const forbiddenPaths = JSON.parse(Buffer.from(process.env.GREENROOM_PROVIDER_ACCEPTANCE_FORBIDDEN_B64!, "base64").toString("utf8")) as string[];
  for (const forbidden of forbiddenPaths) {
    assert.throws(() => readFileSync(forbidden), (error: unknown) => ["EACCES", "EPERM", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""));
  }

  const distRoot = join(appRoot, "Contents/Resources/app/dist");
  const required = [
    join(distRoot, "src/app.js"), join(distRoot, "src/db/index.js"), join(distRoot, "src/providers/credential-store.js"),
    join(distRoot, "src/providers/keychain-helper-client.js"), join(distRoot, "src/providers/mock.js"), join(distRoot, "src/providers/secure-http-transport.js"),
  ];
  const manifest = JSON.parse(readFileSync(join(appRoot, "Contents/Resources/release-manifest.json"), "utf8")) as { files: Array<{ path: string; sha256: string }> };
  const declared = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  for (const path of required) {
    assert.equal(existsSync(path), true, `packaged module missing: ${path}`);
    const manifestPath = relative(appRoot, path).split(sep).join("/");
    assert.equal(declared.get(manifestPath), sha256(path), `packaged module differs from release manifest: ${manifestPath}`);
    assert.equal(strictChild(appRoot, realpathSync(path)), true);
  }

  const dataDir = join(scratch, "data");
  const helper = writeFakeHelper(scratch);
  const requests: Array<{ method: string; url: string; authorization: string | undefined; body: string }> = [];
  const dtoBodies: Buffer[] = [];
  const logBodies: Buffer[] = [];
  const connectionAudit: Array<{ remoteAddress: string; localAddress: string; localPort: number }> = [];
  let tlsConnections = 0;
  let seenSni: string | false | undefined;
  const tlsRoot = join(scratch, "tls");
  mkdirSync(tlsRoot, { mode: 0o700 });
  const configPath = join(tlsRoot, "openssl.cnf");
  const caKeyPath = join(tlsRoot, "ca-key.pem");
  const caCertificatePath = join(tlsRoot, "ca-cert.pem");
  const keyPath = join(tlsRoot, "server-key.pem");
  const requestPath = join(tlsRoot, "server.csr");
  const certificatePath = join(tlsRoot, "server-cert.pem");
  writeFileSync(configPath, [
    "[req]", "distinguished_name=dn", "req_extensions=v3", "prompt=no", "[dn]", "CN=openrouter.ai",
    "[v3]", "subjectAltName=DNS:openrouter.ai", "keyUsage=digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth", "",
  ].join("\n"), { mode: 0o600 });
  const opensslOptions = {
    cwd: scratch, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: "ignore", timeout: 10_000,
  } as const;
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=Green Room Issue 133 Test CA", "-keyout", caKeyPath, "-out", caCertificatePath], opensslOptions);
  execFileSync("/usr/bin/openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", keyPath, "-out", requestPath, "-config", configPath], opensslOptions);
  execFileSync("/usr/bin/openssl", ["x509", "-req", "-sha256", "-days", "1", "-in", requestPath, "-CA", caCertificatePath, "-CAkey", caKeyPath, "-CAcreateserial", "-out", certificatePath, "-extfile", configPath, "-extensions", "v3"], opensslOptions);
  const caCertificate = readFileSync(caCertificatePath);
  const certificate = readFileSync(certificatePath);
  server = createServer({ key: readFileSync(keyPath), cert: certificate, ALPNProtocols: ["http/1.1"] }, (request, response) => {
    let body = "";
    request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, body });
      const value = request.method === "GET" ? { data: [{ id: MODEL }] }
        : { model: JSON.parse(body).model, choices: [{ message: { content: "Packaged local TLS fixture reply." } }] };
      response.writeHead(200, { "content-type": "application/json", connection: "close" }); response.end(JSON.stringify(value));
    });
  });
  server.on("secureConnection", (socket) => {
    tlsConnections += 1; seenSni = (socket as TLSSocket & { servername?: string | false }).servername;
    connectionAudit.push({ remoteAddress: socket.remoteAddress ?? "", localAddress: socket.localAddress ?? "", localPort: socket.localPort ?? 0 });
  });
  await new Promise<void>((done, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string"); const localPort = address.port;

  const [appModule, dbModule, credentialModule, helperModule, mockModule, transportModule] = await Promise.all(required.map((path) => import(pathToFileURL(path).href)));
  const helperDetails = statSync(helper);
  const helperClient = (() => {
    const inheritedTestContext = process.env.NODE_TEST_CONTEXT;
    process.env.NODE_TEST_CONTEXT = "issue133-packaged-acceptance";
    try { return new helperModule.KeychainHelperClient({ executablePath: helper, verifyExecutable: async () => ({ dev: helperDetails.dev, ino: helperDetails.ino }) }); }
    finally {
      if (inheritedTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = inheritedTestContext;
    }
  })();
  const credentials = new credentialModule.KeychainCredentialStore(helperClient);
  const transport = transportModule.__unsafeCreateSecureHttpTransportForTests({
    dependencies: {
      lookup: (hostname: string) => { assert.equal(hostname, "openrouter.ai"); return { promise: Promise.resolve([{ address: GLOBAL_FIXTURE_ADDRESS, family: 4 }]), cancel() {} }; },
      connect: (options: Record<string, unknown>) => {
        assert.equal(options.host, GLOBAL_FIXTURE_ADDRESS); assert.equal(options.port, 443); assert.equal(options.servername, "openrouter.ai"); assert.equal(options.rejectUnauthorized, true);
        const socket = realTlsConnect({ ...options, host: "127.0.0.1", port: localPort, servername: "openrouter.ai", ca: caCertificate });
        socket.once("secureConnect", () => Object.defineProperties(socket, {
          remoteAddress: { configurable: true, value: GLOBAL_FIXTURE_ADDRESS }, remotePort: { configurable: true, value: 443 },
        }));
        return socket;
      },
      request: realHttpsRequest,
    },
    timers: { dns: 1_000, connectTls: 2_000, write: 2_000, headers: 2_000, bodyIdle: 2_000, total: 5_000 },
  });
  const openRuntime = async (): Promise<Runtime> => {
    const store = dbModule.openGreenRoomDatabase({ dataDir, migrationsDir: join(distRoot, "migrations") });
    const app = appModule.buildApp({
      allowedOrigin: ORIGIN, database: store.database, provider: new mockModule.DeterministicMockProvider(),
      providerCredentials: credentials, cloudTransport: transport, publicDir: join(distRoot, "public"),
      logger: { stream: { write(value: string) { logBodies.push(Buffer.from(String(value))); } } } as never,
    });
    try {
      await app.ready();
      const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: HOST } });
      const csrf = (bootstrap.json() as { csrfToken: string }).csrfToken;
      return { app, closeDatabase: () => store.close(), query: (sql: string) => store.database.prepare(sql).all(), async mutate(url, payload) {
        const reply = await app.inject({ method: "POST", url, headers: { host: HOST, origin: ORIGIN, "x-csrf-token": csrf }, payload });
        if (reply.statusCode < 200 || reply.statusCode >= 300) assert.fail(`${url}: unexpected HTTP status ${reply.statusCode}`);
        assert.equal(reply.body.includes(SECRET), false, "provider DTO retained credential sentinel");
        dtoBodies.push(Buffer.from(reply.body));
        return reply.json();
      } };
    } catch (error) {
      try { await app.close(); } catch { /* retain the startup failure */ } finally { store.close(); }
      throw error;
    }
  };
  const closeRuntime = async () => {
    if (runtime === undefined) return;
    const closing = runtime; runtime = undefined;
    try { await closing.app.close(); } finally { closing.closeDatabase(); }
  };

  let eventEvidence = Buffer.alloc(0);
  let snapshotEvidence = Buffer.alloc(0);
  try {
    runtime = await openRuntime();
    await runtime.mutate("/api/providers/connections", { id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1 });
    assert.deepEqual((await runtime.mutate("/api/providers/connections/openrouter-main/models", { connectionRevision: 1 })).models, [MODEL]);
    assert.equal((await runtime.mutate("/api/providers/connections/openrouter-main/test", { connectionRevision: 1, modelId: MODEL })).status, "ready");
    const selected = await runtime.mutate("/api/providers/model-profiles", { id: "openrouter-selected", connectionId: "openrouter-main", connectionRevision: 1, modelId: MODEL, temperature: 0, maxOutputTokens: 16, acknowledgedConnectionRevision: 1 });
    await runtime.mutate("/api/rooms/first-playable/provider-binding", { id: "first-playable-provider", expectedRevision: 0, modelProfileId: selected.modelProfile.profile.id, modelProfileRevision: selected.modelProfile.profile.revision, acknowledgedConnectionRevision: 1 });
    assert.equal((await runtime.mutate("/api/rooms/first-playable/messages", { requestId: "packaged-openrouter-before-restart", selectionRevision: 0, text: "Say ready.", wantsResponse: true })).outcome, "text");
    await closeRuntime();
    runtime = await openRuntime();
    const current = await runtime.app.inject({ method: "GET", url: "/api/rooms/current", headers: { host: HOST } });
    dtoBodies.push(Buffer.from(current.body));
    assert.equal((await runtime.mutate("/api/rooms/first-playable/messages", { requestId: "packaged-openrouter-after-restart", selectionRevision: current.json<{ revision: number }>().revision, text: "Say ready after restart.", wantsResponse: true })).outcome, "text");
    const events = await runtime.app.inject({ method: "GET", url: "/api/rooms/first-playable/events?after=0", headers: { host: HOST } });
    assert.equal(events.statusCode, 200, "event audit endpoint failed");
    eventEvidence = Buffer.from(events.body); dtoBodies.push(eventEvidence);
    snapshotEvidence = Buffer.from(JSON.stringify(runtime.query("SELECT snapshot_json, provider_definition_id, provider_definition_version, routing_policy FROM provider_decision_snapshots ORDER BY request_id")));
  } finally { await closeRuntime(); }

  let helperErrorEvidence = Buffer.alloc(0);
  try {
    await credentials.put("credential:openrouter-main:1", Buffer.from(SECRET));
    assert.fail("duplicate credential helper request unexpectedly succeeded");
  } catch (error) {
    helperErrorEvidence = Buffer.from(String(error));
  }
  assert.equal(await credentials.delete("credential:openrouter-main:1"), true);

  server.closeAllConnections(); await new Promise<void>((done) => server!.close(() => done())); server = undefined;
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: "GET", url: "/api/v1/models" }, { method: "POST", url: "/api/v1/chat/completions" },
    { method: "POST", url: "/api/v1/chat/completions" }, { method: "POST", url: "/api/v1/chat/completions" },
  ]);
  assert.equal(requests.every((request) => request.authorization === `Bearer ${SECRET}`), true);
  const postBodies = requests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body));
  assert.deepEqual(postBodies.map((body) => body.max_tokens), [32, 16, 16]);
  assert.equal(postBodies.every((body) => body.model === MODEL && body.stream === false && body.provider?.allow_fallbacks === false), true);
  assert.equal(seenSni, "openrouter.ai"); assert.equal(tlsConnections, requests.length); assert.equal(connectionAudit.length, requests.length);
  assert.equal(connectionAudit.every((entry) => entry.remoteAddress === "127.0.0.1" && entry.localAddress === "127.0.0.1" && entry.localPort === localPort), true);
  const externalRequests = connectionAudit.filter((entry) => entry.remoteAddress !== "127.0.0.1" || entry.localAddress !== "127.0.0.1").length;
  assert.equal(externalRequests, 0);
  const diagnostics = transport.diagnostics();
  assert.deepEqual(diagnostics, { dns: 0, sockets: 0, closing: 0, agents: 0, active: 0, queued: 0 });

  const exportPath = join(scratch, "provider-state-export.json");
  const backupPath = join(scratch, "provider-state-backup.sqlite");
  writeFileSync(exportPath, JSON.stringify(dtoBodies.map((body) => JSON.parse(body.toString("utf8")))), { mode: 0o600 });
  copyFileSync(join(dataDir, "greenroom.sqlite"), backupPath);
  const dbFiles = ["greenroom.sqlite", "greenroom.sqlite-wal", "greenroom.sqlite-shm"].map((name) => join(dataDir, name));
  const packageFiles = regularFilesRecursively(appRoot);
  const staticFiles = regularFilesRecursively(join(distRoot, "public"));
  const packFiles = packageFiles.filter((path) => /(?:persona|pack)/iu.test(relative(appRoot, path)));
  const processListingSignal = join(ownedHarnessRoot, "process-listing.ready");
  assert.equal(process.env.GREENROOM_PROVIDER_ACCEPTANCE_PROCESS_LISTING_SIGNAL, processListingSignal);
  const processListingFd = Number(process.env.GREENROOM_PROVIDER_ACCEPTANCE_PROCESS_LISTING_FD);
  assert.equal(Number.isSafeInteger(processListingFd) && processListingFd >= 3, true, "outer controller process-listing FD was invalid");
  writeFileSync(processListingSignal, "ready", { flag: "wx", mode: 0o600 });
  const processListing = readFileSync(processListingFd);
  assert.ok(processListing.length > 0, "outer controller process listing was empty");
  const sentinelAudit = {
    forms: ["raw-utf8", "base64", "base64url", "hex", "percent-encoded"],
    surfaces: ["db-wal-shm", "events", "snapshots", "dtos", "logs", "diagnostics", "exports-backups", "packs", "static-assets", "helper-errors", "process-listings-environment", "package-evidence"],
  } as const;
  const evidenceBeforeAudit = {
    code: "packaged_openrouter_acceptance_evidence", schemaVersion: 1, provider: "openrouter", model: MODEL, status: "passed",
    runtime: { node: process.version, executable: "Contents/Resources/runtime/node/bin/node", harness: "external-copy" },
    fixture: { protocol: "real-tls-http1-loopback", hostname: "openrouter.ai", sni: seenSni, portContract: 443, localPort, requests: requests.length, connections: tlsConnections },
    networkAudit: { connections: connectionAudit, externalRequests }, quiescent: true,
    sentinelAudit,
  };
  const sentinels = sentinelForms(SECRET);
  assert.equal(new Set(sentinels.map((value) => value.toString("utf8"))).size, sentinels.length, "credential sentinel forms must be independent");
  const surfaces: ReadonlyArray<readonly [string, readonly Buffer[]]> = [
    ["db-wal-shm", dbFiles.map((path) => existsSync(path) ? readFileSync(path) : Buffer.alloc(0))],
    ["events", [eventEvidence]], ["snapshots", [snapshotEvidence]], ["dtos", dtoBodies],
    ["logs", logBodies], ["diagnostics", [Buffer.from(JSON.stringify(diagnostics))]],
    ["exports-backups", [readFileSync(exportPath), readFileSync(backupPath)]],
    ["packs", packFiles.map((path) => readFileSync(path))], ["static-assets", staticFiles.map((path) => readFileSync(path))],
    ["helper-errors", [helperErrorEvidence, readFileSync(join(scratch, "fake-keychain.json"))]],
    ["process-listings-environment", [processListing, Buffer.from(JSON.stringify(process.env))]],
    ["package-evidence", [Buffer.from(JSON.stringify(evidenceBeforeAudit))]],
  ];
  assert.ok(eventEvidence.length > 0 && snapshotEvidence.length > 0 && dtoBodies.length > 0 && logBodies.length > 0, "runtime sentinel audit surfaces were empty");
  assert.ok(packFiles.length > 0 && staticFiles.length > 0, "packaged sentinel audit surfaces were empty");
  let secretSentinelCount = 0;
  for (const [surface, values] of surfaces) {
    assertSurfaceClean(surface, values, sentinels);
    for (const value of values) for (const sentinel of sentinels) if (value.includes(sentinel)) secretSentinelCount += 1;
  }
  assert.equal(secretSentinelCount, 0, "credential sentinel audit was nonzero");
  const packagedEvidence = { ...evidenceBeforeAudit, sentinelAudit: { ...sentinelAudit, secretSentinelCount } };
  assertSurfaceClean("package-evidence", [Buffer.from(JSON.stringify(packagedEvidence))], sentinels);
  process.stdout.write(`${JSON.stringify(packagedEvidence)}\n`);
});
