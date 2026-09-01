import { acquireDataRootWriterLock, DataRootInUseError } from "../../src/runtime/data-root-lock.js";

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("data root argument required");

try {
  const lock = acquireDataRootWriterLock(dataDir);
  process.stdout.write(`${JSON.stringify({ event: "lock_acquired", pid: process.pid })}\n`);
  if (process.argv[3] === "attempt") {
    lock.release();
    process.exit(0);
  }
  const stop = (signal: string): void => {
    lock.release();
    process.stdout.write(`${JSON.stringify({ event: "lock_released", signal })}\n`);
    process.exit(0);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  setInterval(() => undefined, 60_000);
} catch (error) {
  if (error instanceof DataRootInUseError) {
    process.stderr.write(`${JSON.stringify({ code: error.code })}\n`);
    process.exit(73);
  }
  throw error;
}
