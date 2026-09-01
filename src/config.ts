import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

import {
  DEFAULT_LM_STUDIO_MODEL,
  validateLMStudioModel,
} from "./providers/lm-studio.js";

export interface AppConfig {
  readonly acceptanceFixture: "first-playable-v1" | null;
  readonly allowedOrigin: string;
  readonly dataDir: string;
  readonly host: string;
  readonly lmStudioModel: string;
  readonly personaInspectionExecutable: string | null;
  readonly personaInspectionMode: "disabled" | "optional" | "required";
  readonly personaInspectionSafeCwd: string;
  readonly personaInspectionTempParent: string;
  readonly port: number;
  readonly provider: "mock" | "lmstudio";
}

function personaInspectionMode(
  value: string | undefined,
): "disabled" | "optional" | "required" {
  if (value === undefined || value === "optional") return "optional";
  if (value === "disabled" || value === "required") return value;
  throw new Error(
    "GREENROOM_PERSONA_INSPECTION must be disabled, optional, or required",
  );
}

function personaInspectionExecutable(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value === "" || !isAbsolute(value)) {
    throw new Error(
      "GREENROOM_PERSONA_VALIDATOR_EXECUTABLE must be an absolute path",
    );
  }
  return value;
}

function generationProvider(value: string | undefined): "mock" | "lmstudio" {
  if (value === undefined || value === "mock") {
    return "mock";
  }
  if (value === "lmstudio") {
    return value;
  }
  throw new Error("GREENROOM_PROVIDER must be mock or lmstudio");
}

function lmStudioModel(value: string | undefined): string {
  try {
    return validateLMStudioModel(value ?? DEFAULT_LM_STUDIO_MODEL);
  } catch {
    throw new Error(
      "GREENROOM_LMSTUDIO_MODEL must be a canonical ID of at most 128 characters",
    );
  }
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

function allowedOrigin(value: string | undefined, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "GREENROOM_ALLOWED_ORIGIN must be a canonical Tailscale HTTPS origin",
    );
  }

  if (
    value !== parsed.origin ||
    parsed.protocol !== "https:" ||
    !parsed.hostname.endsWith(".ts.net") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "GREENROOM_ALLOWED_ORIGIN must be a canonical Tailscale HTTPS origin",
    );
  }

  return value;
}

export function loadConfig(
  environment: Environment = process.env,
  cwd: string = process.cwd(),
): AppConfig {
  const host = loopbackHost(environment.GREENROOM_HOST);
  const port = listenPort(environment.GREENROOM_PORT);
  const dataDir = dataDirectory(environment.GREENROOM_DATA_DIR, cwd);
  const personaInspectionRoot = join(dataDir, "runtime", "persona-inspection");
  return {
    acceptanceFixture: acceptanceFixture(
      environment.GREENROOM_ACCEPTANCE_FIXTURE,
    ),
    allowedOrigin: allowedOrigin(
      environment.GREENROOM_ALLOWED_ORIGIN,
      httpOrigin({ host, port }),
    ),
    dataDir,
    host,
    lmStudioModel: lmStudioModel(environment.GREENROOM_LMSTUDIO_MODEL),
    personaInspectionExecutable: personaInspectionExecutable(
      environment.GREENROOM_PERSONA_VALIDATOR_EXECUTABLE,
    ),
    personaInspectionMode: personaInspectionMode(
      environment.GREENROOM_PERSONA_INSPECTION,
    ),
    personaInspectionSafeCwd: join(personaInspectionRoot, "validator-cwd"),
    personaInspectionTempParent: join(personaInspectionRoot, "tmp"),
    port,
    provider: generationProvider(environment.GREENROOM_PROVIDER),
  };
}
