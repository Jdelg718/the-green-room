import { isIP } from "node:net";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LM_STUDIO_MODEL,
  validateLMStudioModel,
} from "./providers/lm-studio.js";
import { resolveDataRoot, type RuntimeMode } from "./platform/paths.js";

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
  readonly runtimeAssets: RuntimeAssets;
  readonly runtimeMode: RuntimeMode;
}

export interface RuntimeAssets {
  readonly payloadRoot: string | null;
  readonly publicDir: string;
  readonly migrationsDir: string;
  readonly historicalCatalogDir: string;
  readonly originalCatalogDir: string;
  readonly personaPreflightFixture: string;
}

function personaInspectionMode(
  value: string | undefined,
  runtimeMode: RuntimeMode,
): "disabled" | "optional" | "required" {
  if (runtimeMode === "packaged-macos") {
    if (value === undefined || value === "required") return "required";
    throw new Error(
      "GREENROOM_PERSONA_INSPECTION must be required in packaged-macos mode",
    );
  }
  if (value === undefined || value === "optional") return "optional";
  if (value === "disabled" || value === "required") return value;
  throw new Error(
    "GREENROOM_PERSONA_INSPECTION must be disabled, optional, or required",
  );
}

function personaInspectionExecutable(
  value: string | undefined,
  runtimeMode: RuntimeMode,
): string | null {
  if (value === undefined) {
    if (runtimeMode === "packaged-macos") {
      throw new Error(
        "GREENROOM_PERSONA_VALIDATOR_EXECUTABLE is required in packaged-macos mode",
      );
    }
    return null;
  }
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

const PACKAGE_PATH_KEYS = Object.freeze([
  "GREENROOM_PACKAGE_PAYLOAD_ROOT",
  "GREENROOM_PUBLIC_DIR",
  "GREENROOM_MIGRATIONS_DIR",
  "GREENROOM_HISTORICAL_CATALOG_DIR",
  "GREENROOM_ORIGINAL_CATALOG_DIR",
  "GREENROOM_PERSONA_PREFLIGHT_FIXTURE",
] as const);

function absolutePackagePath(environment: Environment, name: typeof PACKAGE_PATH_KEYS[number]): string {
  const value = environment[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required in packaged-macos mode`);
  }
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return value;
}

function runtimeAssets(environment: Environment, mode: RuntimeMode): RuntimeAssets {
  if (mode === "source") {
    for (const name of PACKAGE_PATH_KEYS) {
      if (environment[name] !== undefined) {
        throw new Error(`${name} is accepted only in packaged-macos mode`);
      }
    }
    return Object.freeze({
      payloadRoot: null,
      publicDir: fileURLToPath(new URL("../public", import.meta.url)),
      migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
      historicalCatalogDir: fileURLToPath(new URL("../personas/historical", import.meta.url)),
      originalCatalogDir: fileURLToPath(new URL("../personas/original", import.meta.url)),
      personaPreflightFixture: fileURLToPath(
        new URL("../runtime-assets/persona-validator/valid-minimal.greenroom", import.meta.url),
      ),
    });
  }

  const payloadRoot = absolutePackagePath(environment, "GREENROOM_PACKAGE_PAYLOAD_ROOT");
  const result: RuntimeAssets = {
    payloadRoot,
    publicDir: absolutePackagePath(environment, "GREENROOM_PUBLIC_DIR"),
    migrationsDir: absolutePackagePath(environment, "GREENROOM_MIGRATIONS_DIR"),
    historicalCatalogDir: absolutePackagePath(environment, "GREENROOM_HISTORICAL_CATALOG_DIR"),
    originalCatalogDir: absolutePackagePath(environment, "GREENROOM_ORIGINAL_CATALOG_DIR"),
    personaPreflightFixture: absolutePackagePath(
      environment,
      "GREENROOM_PERSONA_PREFLIGHT_FIXTURE",
    ),
  };
  for (const [name, path] of Object.entries(result)) {
    if (name === "payloadRoot") continue;
    const child = relative(payloadRoot, path);
    if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error(`${name} must be a strict child of GREENROOM_PACKAGE_PAYLOAD_ROOT`);
    }
  }
  return Object.freeze(result);
}

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
  platform: NodeJS.Platform = process.platform,
): AppConfig {
  const host = loopbackHost(environment.GREENROOM_HOST);
  const port = listenPort(environment.GREENROOM_PORT);
  const { dataDir, runtimeMode } = resolveDataRoot({ cwd, environment, platform });
  const assets = runtimeAssets(environment, runtimeMode);
  const personaInspectionRoot = join(dataDir, "runtime", "persona-inspection");
  return Object.freeze({
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
      runtimeMode,
    ),
    personaInspectionMode: personaInspectionMode(
      environment.GREENROOM_PERSONA_INSPECTION,
      runtimeMode,
    ),
    personaInspectionSafeCwd: join(personaInspectionRoot, "validator-cwd"),
    personaInspectionTempParent: join(personaInspectionRoot, "tmp"),
    port,
    provider: generationProvider(environment.GREENROOM_PROVIDER),
    runtimeAssets: assets,
    runtimeMode,
  });
}
