import type { AppConfig } from "../config.js";
import { FileCredentialStore } from "./credential-store.js";
import { createSecureHttpTransport } from "./secure-http-transport.js";

export function sourceCredentialRuntime(
  config: Pick<AppConfig, "credentialStoreMode" | "dataDir" | "runtimeMode">,
): {
  readonly providerCredentials: FileCredentialStore;
  readonly cloudTransport: ReturnType<typeof createSecureHttpTransport>;
} | undefined {
  if (config.runtimeMode !== "source" || config.credentialStoreMode !== "file") {
    return undefined;
  }
  return {
    providerCredentials: new FileCredentialStore(config.dataDir),
    cloudTransport: createSecureHttpTransport(),
  };
}
