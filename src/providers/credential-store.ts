import type { KeychainHelperClient } from "./keychain-helper-client.js";

const REFERENCE = /^credential:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:[1-9][0-9]{0,9}$/u;

export interface CredentialStore {
  put(reference: string, secret: Buffer, signal?: AbortSignal): Promise<void>;
  get(reference: string, signal?: AbortSignal): Promise<Buffer | null>;
  replace(reference: string, secret: Buffer, signal?: AbortSignal): Promise<void>;
  delete(reference: string, signal?: AbortSignal): Promise<boolean>;
}

export function canonicalCredentialReference(connectionId: string, revision: number): string {
  const reference = `credential:${connectionId}:${revision}`;
  if (!REFERENCE.test(reference) || !Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) {
    const error = new TypeError("credential_reference_invalid") as TypeError & { code: string };
    error.code = "credential_reference_invalid";
    throw error;
  }
  return reference;
}

function validate(reference: string): void {
  if (!REFERENCE.test(reference)) {
    const error = new TypeError("credential_reference_invalid") as TypeError & { code: string };
    error.code = "credential_reference_invalid";
    throw error;
  }
}

/** A narrow ownership boundary that clears caller-provided key buffers after writes. */
export class KeychainCredentialStore implements CredentialStore {
  readonly #client: Pick<KeychainHelperClient, "put" | "get" | "replace" | "delete">;
  constructor(client: Pick<KeychainHelperClient, "put" | "get" | "replace" | "delete">) { this.#client = client; }
  async put(reference: string, secret: Buffer, signal?: AbortSignal): Promise<void> {
    validate(reference);
    try { await this.#client.put(reference, secret, signal); } finally { secret.fill(0); }
  }
  async get(reference: string, signal?: AbortSignal): Promise<Buffer | null> { validate(reference); return this.#client.get(reference, signal); }
  async replace(reference: string, secret: Buffer, signal?: AbortSignal): Promise<void> {
    validate(reference);
    try { await this.#client.replace(reference, secret, signal); } finally { secret.fill(0); }
  }
  async delete(reference: string, signal?: AbortSignal): Promise<boolean> { validate(reference); return this.#client.delete(reference, signal); }
}
