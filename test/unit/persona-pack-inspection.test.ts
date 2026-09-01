import assert from "node:assert/strict";
import { mkdtemp, open, readdir, readFile, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import {
  PersonaPackInspectionError,
  PersonaPackInspectionService,
  type PersonaPackInspectionErrorCode,
  type PersonaPackValidator,
} from "../../src/personas/persona-pack-inspection.js";
import type { ValidatorReport } from "../../src/personas/validator-sidecar.js";

const VALID_REPORT: ValidatorReport = Object.freeze({
  reportVersion: "1",
  valid: true,
  loadable: true,
  diagnosticCodes: Object.freeze([]),
  errorCodes: Object.freeze([]),
  warningCodes: Object.freeze([]),
  diagnosticsTruncated: false,
  diagnosticsOmitted: 0,
  runtimeFiles: Object.freeze(["AGENTS.md", "BACKGROUND.md", "VOICE.md"]),
  promptSha256: "a".repeat(64),
  promptUtf8Bytes: 123,
});

async function withTempParent(run: (tempParent: string) => Promise<void>): Promise<void> {
  const tempParent = await mkdtemp(join(tmpdir(), "greenroom-inspection-test-"));
  try {
    await run(tempParent);
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
}

function validator(
  validate: PersonaPackValidator["validate"],
): PersonaPackValidator {
  return { validate };
}

function hasCode(code: PersonaPackInspectionErrorCode) {
  return (error: unknown) => error instanceof PersonaPackInspectionError && error.code === code;
}

async function assertClean(tempParent: string): Promise<void> {
  assert.deepEqual(await readdir(tempParent), []);
}

test("streams to a private app-named file, closes it, and returns only frozen sanitized metadata", async () => {
  await withTempParent(async (tempParent) => {
    const input = Buffer.from("hostile archive bytes");
    let validatorPath = "";
    const service = new PersonaPackInspectionService({
      tempParent,
      validator: validator(async (archivePath) => {
        validatorPath = archivePath;
        assert.equal(isAbsolute(archivePath), true);
        assert.equal(basename(archivePath), "persona-pack.greenroom");
        assert.deepEqual(await readFile(archivePath), input);
        const fileStat = await stat(archivePath);
        const directoryStat = await stat(dirname(archivePath));
        if (process.platform !== "win32") {
          assert.equal(fileStat.mode & 0o777, 0o600);
          assert.equal(directoryStat.mode & 0o777, 0o700);
        }
        return VALID_REPORT;
      }),
    });

    const result = await service.inspect(Readable.from([input]), new AbortController().signal);

    assert.equal(result.uploadedBytes, input.length);
    assert.equal(result.archiveSha256, "8ab2771795b3a857b24c93a88dc08779dc42af8010882cd41947842acbdf5466");
    assert.equal(result.reportVersion, "1");
    assert.deepEqual(result.runtimeFiles, ["AGENTS.md", "BACKGROUND.md", "VOICE.md"]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.runtimeFiles), true);
    assert.equal("rawBytes" in result, false);
    assert.equal("tempPath" in result, false);
    assert.equal("filename" in result, false);
    assert.equal("prompt" in result, false);
    assert.equal("messages" in result, false);
    assert.equal((await readdir(tempParent)).length, 0);
    assert.notEqual(validatorPath, "");
  });
});

test("accepts exactly 4 MiB across chunk boundaries and reads only the first byte over", async () => {
  await withTempParent(async (tempParent) => {
    const limit = 4 * 1024 * 1024;
    let validatedBytes = 0;
    const service = new PersonaPackInspectionService({
      tempParent,
      validator: validator(async (archivePath) => {
        validatedBytes = (await stat(archivePath)).size;
        return VALID_REPORT;
      }),
    });
    const exact = await service.inspect(
      Readable.from([Buffer.alloc(limit - 7, 0x61), Buffer.alloc(7, 0x62)]),
      new AbortController().signal,
    );
    assert.equal(exact.uploadedBytes, limit);
    assert.equal(validatedBytes, limit);
    await assertClean(tempParent);

    let pulls = 0;
    const oversized: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        const chunks = [Buffer.alloc(limit, 0x61), Buffer.from([0x62]), Buffer.from("must-not-read")];
        return {
          async next() {
            const value = chunks[pulls++];
            return value ? { done: false, value } : { done: true, value: undefined };
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    };
    await assert.rejects(
      service.inspect(oversized, new AbortController().signal),
      hasCode("inspection_too_large"),
    );
    assert.equal(pulls, 2);
    await assertClean(tempParent);
  });
});

test("rejects empty input and hostile stream failures without validating or leaking causes", async () => {
  await withTempParent(async (tempParent) => {
    let validations = 0;
    const service = new PersonaPackInspectionService({
      tempParent,
      validator: validator(async () => {
        validations += 1;
        return VALID_REPORT;
      }),
    });
    await assert.rejects(
      service.inspect(Readable.from([]), new AbortController().signal),
      hasCode("inspection_empty"),
    );

    const hostile = async function* () {
      yield Buffer.from("partial");
      throw new Error("SECRET_STREAM_PATH_/private/file.greenroom");
    };
    let caught: unknown;
    try {
      await service.inspect(hostile(), new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof PersonaPackInspectionError);
    assert.equal(caught.code, "inspection_stream_error");
    assert.equal(String(caught).includes("SECRET"), false);
    assert.equal(String(caught).includes("/private/file.greenroom"), false);
    assert.equal(validations, 0);
    await assertClean(tempParent);
  });
});

test("fails closed on partial and zero-byte filesystem writes", async () => {
  await withTempParent(async (tempParent) => {
    const probePath = join(tempParent, "prototype-probe");
    const probe = await open(probePath, "w+");
    const prototype = Object.getPrototypeOf(probe) as {
      write: typeof probe.write;
    };
    const originalWrite = prototype.write;
    await probe.close();
    await rm(probePath);

    const service = new PersonaPackInspectionService({
      tempParent,
      validator: validator(async (archivePath) => {
        assert.deepEqual(await readFile(archivePath), Buffer.from("partial-write-test"));
        return VALID_REPORT;
      }),
    });
    try {
      prototype.write = (async function (
        this: FileHandle,
        buffer: Uint8Array,
        offset = 0,
        length = buffer.byteLength,
        position: number | null = null,
      ) {
        return await Reflect.apply(originalWrite, this, [buffer, offset, Math.min(length, 3), position]);
      }) as typeof probe.write;
      const result = await service.inspect(
        Readable.from([Buffer.from("partial-write-test")]),
        new AbortController().signal,
      );
      assert.equal(result.uploadedBytes, 18);

      prototype.write = (async function (buffer: Uint8Array) {
        return { bytesWritten: 0, buffer };
      }) as typeof probe.write;
      await assert.rejects(
        service.inspect(Readable.from([Buffer.from("cannot-write")]), new AbortController().signal),
        hasCode("inspection_write_error"),
      );

      const duringWrite = new AbortController();
      let writeCalls = 0;
      prototype.write = (async function (
        this: FileHandle,
        buffer: Uint8Array,
        offset = 0,
        length = buffer.byteLength,
        position: number | null = null,
      ) {
        const result = await Reflect.apply(originalWrite, this, [buffer, offset, Math.min(length, 3), position]);
        writeCalls += 1;
        duringWrite.abort();
        return result;
      }) as typeof probe.write;
      await assert.rejects(
        service.inspect(Readable.from([Buffer.from("abort-mid-write")]), duringWrite.signal),
        hasCode("inspection_aborted"),
      );
      assert.equal(writeCalls, 1);
    } finally {
      prototype.write = originalWrite;
    }
    await assertClean(tempParent);
  });
});

test("honors cancellation before upload, during streaming, and during validation", async () => {
  await withTempParent(async (tempParent) => {
    let validations = 0;
    const service = new PersonaPackInspectionService({
      tempParent,
      validator: validator(async (_archivePath, options) => {
        validations += 1;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("SECRET_VALIDATOR_ABORT")), { once: true });
        });
        return VALID_REPORT;
      }),
    });

    const before = new AbortController();
    before.abort();
    await assert.rejects(service.inspect(Readable.from([Buffer.from("x")]), before.signal), hasCode("inspection_aborted"));
    await assertClean(tempParent);

    let returned = false;
    let pulls = 0;
    const duringSource: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            pulls += 1;
            if (pulls === 1) return Promise.resolve({ done: false, value: Buffer.from("partial") });
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const during = new AbortController();
    const streaming = service.inspect(duringSource, during.signal);
    setTimeout(() => during.abort(), 20);
    await assert.rejects(streaming, hasCode("inspection_aborted"));
    assert.equal(returned, true);
    await assertClean(tempParent);

    const validating = new AbortController();
    const pending = service.inspect(Readable.from([Buffer.from("complete")]), validating.signal);
    while (validations === 0) await new Promise((resolve) => setImmediate(resolve));
    validating.abort();
    await assert.rejects(pending, hasCode("inspection_aborted"));
    await assertClean(tempParent);
  });
});

test("bounds disk and validator concurrency while keeping uploads isolated", async () => {
  await withTempParent(async (tempParent) => {
    let active = 0;
    let maxActive = 0;
    const seenPaths = new Set<string>();
    const seenBodies = new Set<string>();
    const service = new PersonaPackInspectionService({
      tempParent,
      concurrency: 2,
      validator: validator(async (archivePath) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        seenPaths.add(archivePath);
        seenBodies.add((await readFile(archivePath, "utf8")));
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return VALID_REPORT;
      }),
    });
    const bodies = ["alpha", "bravo", "charlie", "delta"];
    const results = await Promise.all(
      bodies.map((body) => service.inspect(Readable.from([Buffer.from(body)]), new AbortController().signal)),
    );
    assert.equal(maxActive, 2);
    assert.equal(seenPaths.size, 4);
    assert.deepEqual([...seenBodies].sort(), [...bodies].sort());
    assert.deepEqual(results.map((result) => result.uploadedBytes), bodies.map((body) => body.length));
    await assertClean(tempParent);
  });
});

test("returns coherent rejected reports but fails closed on validator failures or inconsistent reports", async () => {
  await withTempParent(async (tempParent) => {
    const rejectedReport: ValidatorReport = {
      reportVersion: "1",
      valid: false,
      loadable: false,
      diagnosticCodes: ["invalid_zip"],
      errorCodes: ["invalid_zip"],
      warningCodes: [],
      diagnosticsTruncated: false,
      diagnosticsOmitted: 0,
      runtimeFiles: [],
      promptSha256: null,
      promptUtf8Bytes: null,
    };
    const rejected = await new PersonaPackInspectionService({
      tempParent,
      validator: validator(async () => rejectedReport),
    }).inspect(Readable.from([Buffer.from("bad zip")]), new AbortController().signal);
    assert.equal(rejected.valid, false);
    assert.deepEqual(rejected.errorCodes, ["invalid_zip"]);
    assert.equal(Object.isFrozen(rejected.errorCodes), true);
    await assertClean(tempParent);

    let promptDigestReads = 0;
    const shiftingReport = new Proxy(
      { ...VALID_REPORT, privatePath: "/tmp/SECRET-pack.greenroom", rawPrompt: "SECRET_PROMPT" },
      {
        get(target, property, receiver) {
          if (property === "promptSha256") {
            promptDigestReads += 1;
            return promptDigestReads === 1 ? "a".repeat(64) : "SECRET_PROMPT";
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as ValidatorReport;
    const shifted = await new PersonaPackInspectionService({
      tempParent,
      validator: validator(async () => shiftingReport),
    }).inspect(Readable.from([Buffer.from("archive")]), new AbortController().signal);
    assert.equal(shifted.promptSha256, "a".repeat(64));
    assert.equal(promptDigestReads, 1);
    assert.equal(JSON.stringify(shifted).includes("SECRET"), false);
    assert.equal(JSON.stringify(shifted).includes("/tmp/"), false);
    await assertClean(tempParent);

    for (const validate of [
      async () => { throw new Error("SECRET /tmp/private-pack.greenroom"); },
      async () => ({ ...VALID_REPORT, promptSha256: null, secret: "SECRET_PROMPT" }) as ValidatorReport,
    ]) {
      let caught: unknown;
      try {
        await new PersonaPackInspectionService({ tempParent, validator: validator(validate) })
          .inspect(Readable.from([Buffer.from("archive")]), new AbortController().signal);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof PersonaPackInspectionError);
      assert.equal(caught.code, "inspection_validation_failed");
      assert.equal(String(caught).includes("SECRET"), false);
      assert.equal(String(caught).includes("/tmp/private-pack.greenroom"), false);
      await assertClean(tempParent);
    }
  });
});

test("rejects unsafe constructor values and non-byte upload values with fixed public errors", async () => {
  const validValidator = validator(async () => VALID_REPORT);
  assert.throws(
    () => new PersonaPackInspectionService(null as unknown as ConstructorParameters<typeof PersonaPackInspectionService>[0]),
    hasCode("inspection_invalid_configuration"),
  );
  assert.throws(
    () => new PersonaPackInspectionService({ tempParent: "relative", validator: validValidator }),
    hasCode("inspection_invalid_configuration"),
  );
  assert.throws(
    () => new PersonaPackInspectionService({ tempParent: tmpdir(), validator: validValidator, concurrency: 0 }),
    hasCode("inspection_invalid_configuration"),
  );
  assert.throws(
    () => new PersonaPackInspectionService({ tempParent: tmpdir(), validator: validValidator, concurrency: 9 }),
    hasCode("inspection_invalid_configuration"),
  );

  await withTempParent(async (tempParent) => {
    let validatorGetterReads = 0;
    const shiftingValidator = new Proxy({}, {
      get(_target, property) {
        if (property !== "validate") return undefined;
        validatorGetterReads += 1;
        if (validatorGetterReads === 1) return async () => VALID_REPORT;
        throw new Error("SECRET_VALIDATOR_GETTER");
      },
    }) as PersonaPackValidator;
    const snapshotted = new PersonaPackInspectionService({ tempParent, validator: shiftingValidator });
    const result = await snapshotted.inspect(
      Readable.from([Buffer.from("validator getter")]),
      new AbortController().signal,
    );
    assert.equal(result.valid, true);
    assert.equal(validatorGetterReads, 1);
    await assertClean(tempParent);

    const service = new PersonaPackInspectionService({ tempParent, validator: validValidator });
    const strings = Readable.from(["browser-file-name.greenroom"]);
    strings.setEncoding("utf8");
    await assert.rejects(
      service.inspect(strings as unknown as AsyncIterable<Uint8Array>, new AbortController().signal),
      hasCode("inspection_invalid_input"),
    );

    const hostileSignal = new Proxy(new AbortController().signal, {
      get() {
        throw new Error("SECRET_SIGNAL_GETTER");
      },
    });
    let signalError: unknown;
    try {
      await service.inspect(Readable.from([Buffer.from("hostile signal")]), hostileSignal);
    } catch (error) {
      signalError = error;
    }
    assert.ok(signalError instanceof PersonaPackInspectionError);
    assert.equal(signalError.code, "inspection_invalid_input");
    assert.equal(String(signalError).includes("SECRET"), false);
    await assertClean(tempParent);
  });
});
