import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp({ logger: true });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
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
  process.exitCode = 1;
}
