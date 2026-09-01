import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openGreenRoomDatabase } from "./db/index.js";
import { loadHistoricalCatalog } from "./personas/historical-catalog.js";
import { selectProvider } from "./providers/select-provider.js";

const config = loadConfig();
const historicalCatalog = loadHistoricalCatalog(
  fileURLToPath(new URL("../personas/historical", import.meta.url)),
);
const store = openGreenRoomDatabase({
  dataDir: config.dataDir,
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
});
const provider = selectProvider({
  acceptanceFixture: config.acceptanceFixture,
  historicalCatalog,
  lmStudioModel: config.lmStudioModel,
  provider: config.provider,
  onAcceptanceLatch(): void {
    process.stdout.write(
      `${JSON.stringify({ event: "acceptance_fixture_latched" })}\n`,
    );
  },
});
const app = buildApp({
  allowedOrigin: config.allowedOrigin,
  database: store.database,
  historicalCatalog,
  logger: true,
  provider,
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
