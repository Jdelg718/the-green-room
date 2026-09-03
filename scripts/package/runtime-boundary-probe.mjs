import dgram from "node:dgram";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [mode, target] = process.argv.slice(2);
const result = { schemaVersion: 1, mode, denied: false };
try {
  if (mode === "write") writeFileSync(target, "TASK13_BOUNDARY_PROBE\n", { flag: "wx", mode: 0o600 });
  else if (mode === "overwrite") writeFileSync(target, "TASK13_BOUNDARY_PROBE_MUTATION\n", { flag: "w" });
  else if (mode === "read") readFileSync(target);
  else if (mode === "exec") {
    const child = spawnSync(target, [], { stdio: "inherit" });
    if (child.error) throw child.error;
    if (child.status !== 0 || child.signal !== null) {
      const error = new Error("external executable did not complete successfully");
      error.code = "EXTERNAL_EXEC_FAILED";
      throw error;
    }
  }
  else if (mode === "network") {
    const socket = dgram.createSocket("udp4");
    try {
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.connect(9, "203.0.113.1", resolve);
      });
      const payload = Buffer.from("probe");
      await new Promise((resolve, reject) => socket.send(payload, 0, payload.length, (error) => error ? reject(error) : resolve()));
    }
    finally { socket.close(); }
  } else throw new Error("unknown probe mode");
} catch (error) {
  result.denied = true;
  result.errorCode = typeof error?.code === "string" ? error.code : "DENIED";
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.denied ? 0 : 9;
