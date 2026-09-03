import { dirname, isAbsolute, parse, resolve } from "node:path";

function quote(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
    throw new TypeError("sandbox paths must be absolute and normalized");
  }
  return `\"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}\"`;
}

export function generateRuntimeSandboxProfile(options) {
  const readRoots = [
    "/System", "/usr/lib", "/usr/share", "/Library/Apple", "/private/var/db", "/private/preboot/Cryptexes",
    "/dev", options.app, options.guard, options.cwd, options.data, options.temp,
    options.home, options.hostileBin, dirname(options.guard), ...(options.probe ? [dirname(options.probe)] : []),
  ];
  const ancestors = new Set(["/"]);
  for (const path of readRoots) {
    let current = path;
    while (current !== parse(current).root) { ancestors.add(current); current = dirname(current); }
  }
  const executableRoots = [options.app];
  const lines = [
    "(version 1)",
    "(deny default)",
    "(deny file-read*)",
    "(deny file-write*)",
    "(deny network*)",
    "(allow process-fork)",
    "(allow process-info* (target self))",
    "(allow signal (target self))",
    "(allow sysctl*)",
    "(allow mach*)",
    "(allow ipc*)",
    "(allow iokit*)",
    `(allow process-exec ${executableRoots.map((path) => `(subpath ${quote(path)})`).join(" ")})`,
    `(allow file-read* ${readRoots.map((path) => `(subpath ${quote(path)})`).join(" ")})`,
    `(allow file-read-data ${[...ancestors].map((path) => `(literal ${quote(path)})`).join(" ")})`,
    `(allow file-read-metadata ${["/", "/private", "/private/tmp", ...readRoots].map((path) => `(subpath ${quote(path)})`).join(" ")})`,
    `(allow file-write* (subpath ${quote(options.data)}) (subpath ${quote(options.temp)}))`,
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
  ];
  return `${lines.join("\n")}\n`;
}

export function sandboxCommand(profilePath, executable, args) {
  for (const path of [profilePath, executable]) quote(path);
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new TypeError("sandbox arguments must be strings without NUL bytes");
  }
  return Object.freeze({ executable: "/usr/bin/sandbox-exec", args: Object.freeze(["-f", profilePath, executable, ...args]) });
}
