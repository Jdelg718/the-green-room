import dgram from "node:dgram";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const auditPath = process.env.GREENROOM_SOCKET_AUDIT_PATH;
if (!auditPath) throw new Error("socket audit path required");
const installed = JSON.parse(readFileSync(auditPath, "utf8")).installedApis;
const deniedLabels = [];
const failures = [];

function accept(label, error) {
  if (error?.code === "ERR_GREENROOM_NETWORK_DENIED") deniedLabels.push(label);
  else failures.push({ label, code: typeof error?.code === "string" ? error.code : "NO_DENIAL" });
}
function synchronous(label, operation) {
  try { operation(); accept(label); } catch (error) { accept(label, error); }
}
function callback(label, operation) {
  return new Promise((resolve) => {
    try { operation((error) => { accept(label, error); resolve(); }); }
    catch (error) { accept(label, error); resolve(); }
  });
}
async function promised(label, operation) {
  try { await operation(); accept(label); } catch (error) { accept(label, error); }
}
function dnsArguments(method, done) {
  if (method === "lookupService") return ["203.0.113.1", 9, done];
  if (method === "reverse") return ["203.0.113.1", done];
  return ["example.invalid", done];
}

for (const label of installed) {
  if (label === "net.Socket.connect") synchronous(label, () => new net.Socket().connect({ host: "203.0.113.1", port: 9 }));
  else if (label === "net.connect") synchronous(label, () => net.connect({ host: "203.0.113.1", port: 9 }));
  else if (label === "net.createConnection") synchronous(label, () => net.createConnection({ host: "203.0.113.1", port: 9 }));
  else if (label === "tls.connect") synchronous(label, () => tls.connect({ host: "203.0.113.1", port: 443 }));
  else if (label === "http.request") synchronous(label, () => http.request("http://203.0.113.1/"));
  else if (label === "http.get") synchronous(label, () => http.get("http://203.0.113.1/"));
  else if (label === "https.request") synchronous(label, () => https.request("https://203.0.113.1/"));
  else if (label === "https.get") synchronous(label, () => https.get("https://203.0.113.1/"));
  else if (label === "fetch") await promised(label, () => fetch("http://203.0.113.1/"));
  else if (label === "dgram.connect") synchronous(label, () => dgram.createSocket("udp4").connect(9, "203.0.113.1"));
  else if (label === "dgram.send") synchronous(label, () => dgram.createSocket("udp4").send("x", 9, "203.0.113.1"));
  else if (label.startsWith("dns.promises.Resolver.")) {
    const method = label.slice("dns.promises.Resolver.".length);
    const resolver = new dns.promises.Resolver();
    await promised(label, () => resolver[method](...dnsArguments(method).slice(0, -1)));
  } else if (label.startsWith("dns.promises.")) {
    const method = label.slice("dns.promises.".length);
    await promised(label, () => dns.promises[method](...dnsArguments(method).slice(0, -1)));
  } else if (label.startsWith("dns.Resolver.")) {
    const method = label.slice("dns.Resolver.".length);
    const resolver = new dns.Resolver();
    await callback(label, (done) => resolver[method](...dnsArguments(method, done)));
  } else if (label.startsWith("dns.")) {
    const method = label.slice("dns.".length);
    await callback(label, (done) => dns[method](...dnsArguments(method, done)));
  } else failures.push({ label, code: "UNKNOWN_INSTALLED_API" });
}

let undiciPackage = { reachable: false, denied: false, underlyingAuditLabels: [] };
try {
  const undici = await import("undici");
  const before = JSON.parse(readFileSync(auditPath, "utf8")).attempts.length;
  let errorCode = "NO_DENIAL";
  try { await undici.fetch("http://203.0.113.1/"); } catch (error) { errorCode = error?.code ?? error?.cause?.code ?? "UNKNOWN"; }
  const attempts = JSON.parse(readFileSync(auditPath, "utf8")).attempts;
  const underlyingAuditLabels = attempts.slice(before).map((entry) => entry.api);
  undiciPackage = { reachable: true, denied: errorCode === "ERR_GREENROOM_NETWORK_DENIED", underlyingAuditLabels };
  if (!undiciPackage.denied || underlyingAuditLabels.length !== 1 || !["net.Socket.connect", "net.connect", "net.createConnection"].includes(underlyingAuditLabels[0])) {
    failures.push({ label: "undici.fetch", code: errorCode });
  }
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") failures.push({ label: "undici.import", code: error?.code ?? "UNKNOWN" });
}

const loopbackForms = ["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.255.255.254", "::1", "[::1]", "::ffff:127.0.0.1"];
for (const host of loopbackForms) {
  await new Promise((resolve) => {
    let socket;
    try {
      socket = net.connect({ host, port: 1 });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", (error) => { if (error?.code === "ERR_GREENROOM_NETWORK_DENIED") failures.push({ label: `loopback:${host}`, code: error.code }); resolve(); });
    } catch (error) { accept(`loopback:${host}`, error); resolve(); }
  });
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  installedLabels: installed,
  deniedLabels,
  denialCount: deniedLabels.length,
  successCount: installed.length - deniedLabels.length,
  loopbackForms,
  globalFetchReachable: typeof globalThis.fetch === "function",
  undiciPackage,
  failures,
})}\n`);
process.exitCode = failures.length === 0 && deniedLabels.length === installed.length ? 0 : 7;
