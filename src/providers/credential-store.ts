import {
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import type { KeychainHelperClient } from "./keychain-helper-client.js";

const REFERENCE = /^credential:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:[1-9][0-9]{0,9}$/u;

export const FILE_CREDENTIAL_STORE_NOTICE = "Credential store: file-based and dev-grade.";

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
  const revision = Number(reference.slice(reference.lastIndexOf(":") + 1));
  if (!REFERENCE.test(reference) || !Number.isSafeInteger(revision) ||
      revision < 1 || revision > 2_147_483_647) {
    const error = new TypeError("credential_reference_invalid") as TypeError & { code: string };
    error.code = "credential_reference_invalid";
    throw error;
  }
}

function credentialError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw credentialError("credential_aborted");
}

function operationError(error: unknown): Error {
  if (error instanceof Error && "code" in error &&
      typeof error.code === "string" && error.code.startsWith("credential_")) {
    return error;
  }
  if (errno(error, "ELOOP") || errno(error, "ENOTDIR") || errno(error, "EISDIR")) {
    return credentialError("credential_store_unsafe");
  }
  return credentialError("credential_store_unavailable");
}

/** Explicit, development-grade POSIX file storage outside the room database. */
export class FileCredentialStore implements CredentialStore {
  readonly #directory: string;

  constructor(dataRoot: string) {
    if (!isAbsolute(dataRoot) || normalize(dataRoot) !== dataRoot) {
      throw credentialError("credential_store_unsafe");
    }
    try {
      const root = lstatSync(dataRoot);
      if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(dataRoot) !== dataRoot) {
        throw credentialError("credential_store_unsafe");
      }
    } catch (error) {
      throw operationError(error);
    }
    this.#directory = join(dataRoot, "credentials");
    this.#prepareDirectory();
  }

  #prepareDirectory(): void {
    let created = false;
    try {
      mkdirSync(this.#directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!errno(error, "EEXIST")) throw operationError(error);
    }
    try {
      if (created) chmodSync(this.#directory, 0o700);
      const stat = lstatSync(this.#directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          (stat.mode & 0o777) !== 0o700 || realpathSync(this.#directory) !== this.#directory) {
        throw credentialError("credential_store_unsafe");
      }
    } catch (error) {
      throw operationError(error);
    }
  }

  #path(reference: string): string {
    validate(reference);
    this.#prepareDirectory();
    return join(this.#directory, reference);
  }

  async put(reference: string, secret: Buffer, signal?: AbortSignal): Promise<void> {
    let path: string | undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      path = this.#path(reference);
      assertNotAborted(signal);
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      await handle.chmod(0o600);
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
        throw credentialError("credential_store_unsafe");
      }
      assertNotAborted(signal);
      await handle.writeFile(secret);
      assertNotAborted(signal);
    } catch (error) {
      if (created && path !== undefined) {
        try { await unlink(path); } catch { /* best-effort removal of an incomplete new file */ }
      }
      if (errno(error, "EEXIST")) throw credentialError("credential_already_exists");
      throw operationError(error);
    } finally {
      try { await handle?.close(); } finally { secret.fill(0); }
    }
  }

  async get(reference: string, signal?: AbortSignal): Promise<Buffer | null> {
    const path = this.#path(reference);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let result: Buffer | undefined;
    try {
      assertNotAborted(signal);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
        throw credentialError("credential_store_unsafe");
      }
      result = await handle.readFile();
      assertNotAborted(signal);
      return result;
    } catch (error) {
      result?.fill(0);
      if (errno(error, "ENOENT")) return null;
      throw operationError(error);
    } finally {
      await handle?.close();
    }
  }

  async replace(reference: string, secret: Buffer, signal?: AbortSignal): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const path = this.#path(reference);
      assertNotAborted(signal);
      handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
        throw credentialError("credential_store_unsafe");
      }
      await handle.truncate(0);
      assertNotAborted(signal);
      await handle.writeFile(secret);
      assertNotAborted(signal);
    } catch (error) {
      if (errno(error, "ENOENT")) throw credentialError("credential_missing");
      throw operationError(error);
    } finally {
      try { await handle?.close(); } finally { secret.fill(0); }
    }
  }

  async delete(reference: string, signal?: AbortSignal): Promise<boolean> {
    const path = this.#path(reference);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      assertNotAborted(signal);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
        throw credentialError("credential_store_unsafe");
      }
      await handle.close();
      handle = undefined;
      assertNotAborted(signal);
      await unlink(path);
      return true;
    } catch (error) {
      if (errno(error, "ENOENT")) return false;
      throw operationError(error);
    } finally {
      await handle?.close();
    }
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
