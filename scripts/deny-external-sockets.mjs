import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net, { isIP } from "node:net";
import tls from "node:tls";
import { writeFileSync } from "node:fs";

const auditPath = process.env.GREENROOM_SOCKET_AUDIT_PATH;
if (auditPath !== undefined) {
  if (process.env.GREENROOM_ACCEPTANCE_FIXTURE !== "first-playable-v1") {
    throw new Error("socket audit is restricted to the first-playable acceptance fixture");
  }

  const MAX_ATTEMPTS = 256;
  const audit = { schemaVersion: 1, installed: true, policy: "loopback-only", installedApis: [], attempts: [], dropped: 0 };
  const persist = () => writeFileSync(auditPath, `${JSON.stringify(audit)}\n`, { mode: 0o600 });
  const record = (api) => {
    if (audit.attempts.length < MAX_ATTEMPTS) audit.attempts.push({ api, target: "external" });
    else audit.dropped += 1;
    persist();
  };
  const denied = (api, host) => {
    record(api);
    const error = new Error("non-loopback network access is disabled during packaged acceptance");
    error.code = "ERR_GREENROOM_NETWORK_DENIED";
    return error;
  };
  const installed = (api) => { audit.installedApis.push(api); persist(); };
  const loopback = (host) => {
    if (host === undefined || host === null || host === "") return true;
    if (typeof host !== "string") return false;
    let normalized = host.toLowerCase();
    if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
    if (normalized === "localhost" || normalized === "localhost.") return true;
    const family = isIP(normalized);
    return (family === 4 && normalized.startsWith("127.")) ||
      (family === 6 && ["::1", "0:0:0:0:0:0:0:1"].includes(normalized)) ||
      /^(?:::ffff:|0:0:0:0:0:ffff:)127\./.test(normalized);
  };
  const connectTarget = (args) => {
    const first = args[0];
    if (first !== null && typeof first === "object") {
      if (typeof first.path === "string") return { local: true, host: "unix" };
      return { local: loopback(first.host), host: first.host };
    }
    if (typeof first === "string" && args.length === 1) return { local: true, host: "unix" };
    return { local: loopback(args[1]), host: args[1] };
  };
  const requestHost = (args) => {
    const first = args[0];
    if (first instanceof URL || typeof first === "string") {
      try { return new URL(first).hostname; } catch { return undefined; }
    }
    return first !== null && typeof first === "object" ? first.hostname ?? first.host : undefined;
  };
  persist();

  const originalNetConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = connectTarget(args);
    if (!target.local) throw denied("net.Socket.connect", target.host);
    return originalNetConnect.apply(this, args);
  };
  installed("net.Socket.connect");
  for (const method of ["connect", "createConnection"]) {
    const original = net[method];
    net[method] = function guardedNetFactory(...args) {
      const target = connectTarget(args);
      if (!target.local) throw denied(`net.${method}`, target.host);
      return original.apply(this, args);
    };
    installed(`net.${method}`);
  }

  const originalTlsConnect = tls.connect;
  tls.connect = function guardedTlsConnect(...args) {
    const target = connectTarget(args);
    if (!target.local) throw denied("tls.connect", target.host);
    return originalTlsConnect.apply(this, args);
  };
  installed("tls.connect");

  for (const [module, label] of [[http, "http"], [https, "https"]]) {
    for (const method of ["request", "get"]) {
      const original = module[method];
      module[method] = function guardedRequest(...args) {
        const host = requestHost(args);
        if (!loopback(host)) throw denied(`${label}.${method}`, host);
        return original.apply(this, args);
      };
      installed(`${label}.${method}`);
    }
  }

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
      let host;
      try { host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname; }
      catch { return originalFetch.call(this, input, init); }
      if (!loopback(host)) return Promise.reject(denied("fetch", host));
      return originalFetch.call(this, input, init);
    };
    installed("fetch");
  }

  const dnsMethods = [...new Set([
    ...Object.keys(dns), ...Object.getOwnPropertyNames(dns.Resolver.prototype),
    ...(dns.promises ? Object.keys(dns.promises) : []),
    ...(dns.promises ? Object.getOwnPropertyNames(dns.promises.Resolver.prototype) : []),
  ])].filter((method) => /^(?:lookup|lookupService|resolve(?:[A-Z0-9].*)?|reverse)$/.test(method)).sort();
  const installCallbackGuard = (target, method, label) => {
    const original = target[method];
    if (typeof original !== "function") return;
    target[method] = function guardedDns(...args) {
      const host = args[0];
      if (loopback(host)) return original.apply(this, args);
      const error = denied(label, host);
      const callback = args.findLast((entry) => typeof entry === "function");
      if (callback) { process.nextTick(callback, error); return this; }
      throw error;
    };
    installed(label);
  };
  const installPromiseGuard = (target, method, label) => {
    const original = target[method];
    if (typeof original !== "function") return;
    target[method] = async function guardedDnsPromise(...args) {
      const host = args[0];
      if (!loopback(host)) throw denied(label, host);
      return original.apply(this, args);
    };
    installed(label);
  };
  for (const method of dnsMethods) {
    installCallbackGuard(dns, method, `dns.${method}`);
    installCallbackGuard(dns.Resolver.prototype, method, `dns.Resolver.${method}`);
  }
  if (dns.promises) {
    for (const method of dnsMethods) {
      installPromiseGuard(dns.promises, method, `dns.promises.${method}`);
      installPromiseGuard(dns.promises.Resolver.prototype, method, `dns.promises.Resolver.${method}`);
    }
  }

  const originalDgramConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function guardedDgramConnect(...args) {
    const address = typeof args[0] === "object" && args[0] !== null ? args[0].address : args[1];
    if (!loopback(address)) throw denied("dgram.connect", address);
    return originalDgramConnect.apply(this, args);
  };
  installed("dgram.connect");
  const originalDgramSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function guardedDgramSend(...args) {
    let address;
    if (typeof args[1] === "number") address = typeof args[2] === "string" ? args[2] : undefined;
    else if (typeof args[2] === "number") address = typeof args[3] === "string" ? args[3] : undefined;
    if (address !== undefined && !loopback(address)) throw denied("dgram.send", address);
    return originalDgramSend.apply(this, args);
  };
  installed("dgram.send");
}
