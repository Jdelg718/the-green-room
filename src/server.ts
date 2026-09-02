import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openGreenRoomDatabase } from "./db/index.js";
import { loadBundledPersonaCatalog } from "./personas/bundled-persona-catalog.js";
import {
  buildPersonaPackInspectionRuntime,
  type PersonaPackInspectionRuntime,
} from "./personas/persona-pack-inspection-runtime.js";
import { selectProvider } from "./providers/select-provider.js";
import {
  acquireDataRootWriterLock,
  DataRootInUseError,
  type DataRootWriterLock,
} from "./runtime/data-root-lock.js";

const config = loadConfig();
const personaCatalog = loadBundledPersonaCatalog({
  historicalRoot: fileURLToPath(new URL("../personas/historical", import.meta.url)),
  originalRoot: fileURLToPath(new URL("../personas/original", import.meta.url)),
});

let store: ReturnType<typeof openGreenRoomDatabase> | undefined;
let runtime: PersonaPackInspectionRuntime | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let dataRootLock: DataRootWriterLock | undefined;
let closing = false;

async function closeResources(): Promise<void> {
  const errors: unknown[] = [];
  const currentApp = app;
  app = undefined;
  if (currentApp) {
    try {
      await currentApp.close();
    } catch (error) {
      errors.push(error);
    }
  }

  const currentRuntime = runtime;
  runtime = undefined;
  if (currentRuntime) {
    try {
      await currentRuntime.close();
    } catch (error) {
      errors.push(error);
    }
  }

  const currentStore = store;
  store = undefined;
  if (currentStore) {
    try {
      currentStore.close();
    } catch (error) {
      errors.push(error);
    }
  }
  const currentDataRootLock = dataRootLock;
  dataRootLock = undefined;
  if (currentDataRootLock) {
    try {
      currentDataRootLock.release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "resource cleanup failed");
}

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app?.log.info({ signal }, "shutting down");
  try {
    await closeResources();
  } catch (error) {
    process.stderr.write(
      `Shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

try {
  dataRootLock = acquireDataRootWriterLock(config.dataDir);
  // Inspection validates and prepares its owned data-directory boundary before
  // SQLite can create or migrate anything beneath an explicitly symlinked path.
  runtime = await buildPersonaPackInspectionRuntime(config);
  store = openGreenRoomDatabase({
    dataDir: config.dataDir,
    migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  const provider = selectProvider({
    acceptanceFixture: config.acceptanceFixture,
    personaCatalog,
    lmStudioModel: config.lmStudioModel,
    provider: config.provider,
    onAcceptanceLatch(): void {
      process.stdout.write(
        `${JSON.stringify({ event: "acceptance_fixture_latched" })}\n`,
      );
    },
  });
  app = buildApp({
    allowedOrigin: config.allowedOrigin,
    database: store.database,
    personaCatalog,
    logger: true,
    provider,
    ...(runtime.service === undefined
      ? {}
      : { personaPackInspectionService: runtime.service }),
    publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  });

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  if (error instanceof DataRootInUseError) {
    process.stderr.write(`${JSON.stringify({ code: error.code })}\n`);
    process.exitCode = 73;
  } else if (app) app.log.error(error, "startup failed");
  else process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  try {
    await closeResources();
  } catch (cleanupError) {
    process.stderr.write(
      `Startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
    );
  }
  if (!(error instanceof DataRootInUseError)) process.exitCode = 1;
}
