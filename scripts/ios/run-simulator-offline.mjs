#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE_ID = "net.greenroomai.GreenRoom";
const APP = ".build/ios/Build/Products/Debug-iphonesimulator/App.app";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-18-6";
const DEVICE_NAME = "iPhone 16 Pro";
const work = mkdtempSync(join(tmpdir(), "greenroom-offline-simulator-"));
const source = join(work, "network-deny.c");
const library = join(work, "network-deny.dylib");

function simctl(arguments_) {
  return execFileSync("/usr/bin/xcrun", ["simctl", ...arguments_], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 8 * 1024 * 1024,
  });
}

function simctlIgnoringFailure(arguments_) {
  spawnSync("/usr/bin/xcrun", ["simctl", ...arguments_], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
}

writeFileSync(source, String.raw`#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void record(const char *event) {
  const char *tmp = getenv("TMPDIR");
  if (!tmp) return;
  char path[4096];
  if (snprintf(path, sizeof(path), "%sgreenroom-network-audit.log", tmp) >= (int)sizeof(path)) return;
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) { dprintf(fd, "%s\n", event); close(fd); }
}
__attribute__((constructor)) static void loaded(void) { setenv("GREENROOM_NETWORK_AUDIT_LOADED", "true", 1); record("audit-loaded"); }
static int internet_family(const struct sockaddr *address) {
  return address && (address->sa_family == AF_INET || address->sa_family == AF_INET6);
}
int connect(int fd, const struct sockaddr *address, socklen_t length) {
  if (internet_family(address)) { setenv("GREENROOM_NETWORK_ATTEMPT", "connect", 1); record("attempt:connect"); errno = ENETDOWN; return -1; }
  static int (*real_connect)(int,const struct sockaddr*,socklen_t);
  if (!real_connect) real_connect = dlsym(RTLD_NEXT, "connect");
  return real_connect(fd, address, length);
}
int bind(int fd, const struct sockaddr *address, socklen_t length) {
  if (internet_family(address)) { setenv("GREENROOM_NETWORK_ATTEMPT", "bind", 1); record("attempt:bind"); errno = EACCES; return -1; }
  static int (*real_bind)(int,const struct sockaddr*,socklen_t);
  if (!real_bind) real_bind = dlsym(RTLD_NEXT, "bind");
  return real_bind(fd, address, length);
}
int listen(int fd, int backlog) {
  struct sockaddr_storage address; socklen_t length = sizeof(address);
  if (getsockname(fd, (struct sockaddr *)&address, &length) == 0 && internet_family((struct sockaddr *)&address)) {
    setenv("GREENROOM_NETWORK_ATTEMPT", "listen", 1); record("attempt:listen"); errno = EACCES; return -1;
  }
  static int (*real_listen)(int,int);
  if (!real_listen) real_listen = dlsym(RTLD_NEXT, "listen");
  return real_listen(fd, backlog);
}
`);

let selected;
try {
  const listing = JSON.parse(simctl(["list", "devices", "available", "--json"]));
  const matches = (listing.devices?.[RUNTIME] ?? []).filter((device) => device.name === DEVICE_NAME && device.isAvailable !== false);
  if (matches.length !== 1) throw new Error(`expected exactly one ${DEVICE_NAME} on iOS 18.6`);
  selected = matches[0];
  const compile = spawnSync("/usr/bin/xcrun", ["--sdk", "iphonesimulator", "clang", "-arch", "arm64", "-mios-simulator-version-min=18.6", "-dynamiclib", source, "-o", library], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (compile.status !== 0) throw new Error(`network-deny interposer failed to compile: ${compile.stderr}`);

  if (selected.state !== "Booted") {
    simctl(["boot", selected.udid]);
  }
  simctl(["bootstatus", selected.udid, "-b"]);
  simctlIgnoringFailure(["terminate", selected.udid, BUNDLE_ID]);
  simctlIgnoringFailure(["uninstall", selected.udid, BUNDLE_ID]);
  simctl(["install", selected.udid, APP]);

  const launch = execFileSync("/usr/bin/xcrun", ["simctl", "launch", selected.udid, BUNDLE_ID], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: library,
    },
  });
  const pidMatch = launch.match(/:\s*([0-9]+)\s*$/u);
  if (!pidMatch) throw new Error("Simulator launch did not return a process ID");
  const pid = pidMatch[1];
  const container = simctl(["get_app_container", selected.udid, BUNDLE_ID, "data"]).trim();
  const evidencePath = join(container, "tmp", "contained-shell-evidence.json");
  const auditPath = join(container, "tmp", "greenroom-network-audit.log");

  let evidence;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  if (JSON.stringify(evidence) !== JSON.stringify({ interposerLoaded: true, networkPolicy: "denied", origin: "capacitor://localhost", status: "ready" })) {
    throw new Error("bundled JavaScript boot evidence was not produced");
  }
  let audit = [];
  try { audit = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean); } catch {}
  const attempts = audit.filter((line) => line.startsWith("attempt:"));
  if (attempts.length > 0) throw new Error(`outbound/listener attempt observed: ${attempts.join(",")}`);
  const sockets = spawnSync("/usr/sbin/lsof", ["-Pan", "-p", pid, "-i"], { encoding: "utf8" });
  if (sockets.status === 0 && /(?:LISTEN|ESTABLISHED|SYN_SENT)/u.test(sockets.stdout)) {
    throw new Error("app process retained a network socket");
  }
  console.log(JSON.stringify({
    status: "PASS",
    simulator: { model: DEVICE_NAME, os: "18.6" },
    app: { bundleIdentifier: BUNDLE_ID, origin: evidence.origin, bundledShell: evidence.status },
    offline: { interposerLoaded: true, outboundAttempts: 0, listeningSockets: 0 },
  }, null, 2));
} finally {
  if (selected) {
    simctlIgnoringFailure(["terminate", selected.udid, BUNDLE_ID]);
  }
  rmSync(work, { recursive: true, force: true });
}
