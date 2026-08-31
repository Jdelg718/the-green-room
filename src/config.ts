import { isIP } from "node:net";
import { resolve } from "node:path";

export interface AppConfig {
  readonly acceptanceFixture: "first-playable-v1" | null;
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
}

function acceptanceFixture(
  value: string | undefined,
): "first-playable-v1" | null {
  if (value === undefined) {
    return null;
  }
  if (value === "first-playable-v1") {
    return value;
  }
  throw new Error(
    "GREENROOM_ACCEPTANCE_FIXTURE must be first-playable-v1 when set",
  );
}

export function httpOrigin(
  config: Pick<AppConfig, "host" | "port">,
): string {
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return new URL(`http://${host}:${config.port}`).origin;
}

type Environment = Readonly<Record<string, string | undefined>>;

function loopbackHost(value: string | undefined): string {
  const host = value ?? "127.0.0.1";
  const family = isIP(host);

  if ((family === 4 && host.startsWith("127.")) || (family === 6 && host === "::1")) {
    return host;
  }

  throw new Error("GREENROOM_HOST must be a loopback IP address");
}

function listenPort(value: string | undefined): number {
  if (value === undefined) {
    return 8787;
  }

  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("GREENROOM_PORT must be an integer from 1 through 65535");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("GREENROOM_PORT must be an integer from 1 through 65535");
  }

  return port;
}

function dataDirectory(value: string | undefined, cwd: string): string {
  if (value === "") {
    throw new Error("GREENROOM_DATA_DIR must not be empty");
  }

  return resolve(cwd, value ?? ".local/first-playable");
}

export function loadConfig(
  environment: Environment = process.env,
  cwd: string = process.cwd(),
): AppConfig {
  return {
    acceptanceFixture: acceptanceFixture(
      environment.GREENROOM_ACCEPTANCE_FIXTURE,
    ),
    dataDir: dataDirectory(environment.GREENROOM_DATA_DIR, cwd),
    host: loopbackHost(environment.GREENROOM_HOST),
    port: listenPort(environment.GREENROOM_PORT),
  };
}
