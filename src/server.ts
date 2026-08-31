import { resolve } from "node:path";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openGreenRoomDatabase } from "./db/index.js";

const config = loadConfig();
const store = openGreenRoomDatabase({
  dataDir: config.dataDir,
  migrationsDir: resolve("migrations"),
});
const app = buildApp({ logger: true });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
  store.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, "startup failed");
  store.close();
  process.exitCode = 1;
}
