import { parentPort, workerData } from "node:worker_threads";

import { openGreenRoomDatabase } from "../../src/db/index.js";

interface WorkerInput {
  readonly dataDir: string;
  readonly gate: SharedArrayBuffer;
  readonly migrationsDir: string;
}

const input = workerData as WorkerInput;
const gate = new Int32Array(input.gate);

parentPort?.postMessage({ status: "ready" });
Atomics.wait(gate, 0, 0);

try {
  const store = openGreenRoomDatabase({
    dataDir: input.dataDir,
    migrationsDir: input.migrationsDir,
  });
  store.close();
  parentPort?.postMessage({ status: "opened" });
} catch (error) {
  parentPort?.postMessage({
    status: "failed",
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}
