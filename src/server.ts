import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openGreenRoomDatabase } from "./db/index.js";
import { DeterministicMockProvider } from "./providers/mock.js";

const config = loadConfig();
const store = openGreenRoomDatabase({
  dataDir: config.dataDir,
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
});
const app = buildApp({
  allowedOrigin: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`,
  database: store.database,
  logger: true,
  provider: new DeterministicMockProvider(),
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
});

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
