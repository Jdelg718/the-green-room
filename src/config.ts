import { isIP } from "node:net";
import { resolve } from "node:path";

export interface AppConfig {
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
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
    dataDir: dataDirectory(environment.GREENROOM_DATA_DIR, cwd),
    host: loopbackHost(environment.GREENROOM_HOST),
    port: listenPort(environment.GREENROOM_PORT),
  };
}
