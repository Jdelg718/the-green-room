import { isAbsolute, resolve } from "node:path";

import { openGreenRoomDatabase, replaceCurrentRoomCast } from "../../src/db/index.js";

const MAX_DATA_DIRECTORY_LENGTH = 4_096;
const MAX_REQUEST_ID_LENGTH = 64;
const MAX_PERSONA_SLUG_LENGTH = 128;
const MAX_PERSONA_NAME_LENGTH = 128;
const MAX_RESULT_LENGTH = 512;

type ProcessResult =
  | Readonly<{ ok: true; sessionId: string }>
  | Readonly<{ ok: false; error: "selection revision conflict" | "cast replacement failed" }>;

function validLiteral(value: string | undefined, maximumLength: number): value is string {
  return value !== undefined &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !/[\0\r\n]/.test(value);
}

function readArguments(): Readonly<{
  dataDir: string;
  requestId: string;
  persona: Readonly<{ slug: string; name: string }>;
}> {
  const [dataDir, requestId, slug, name, extra] = process.argv.slice(2);
  if (
    extra !== undefined ||
    !validLiteral(dataDir, MAX_DATA_DIRECTORY_LENGTH) ||
    !isAbsolute(dataDir) ||
    !validLiteral(requestId, MAX_REQUEST_ID_LENGTH) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestId) ||
    !validLiteral(slug, MAX_PERSONA_SLUG_LENGTH) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
    !validLiteral(name, MAX_PERSONA_NAME_LENGTH) ||
    !/^[A-Za-z0-9 .'-]+$/.test(name)
  ) {
    throw new TypeError("invalid cast process arguments");
  }
  return { dataDir, requestId, persona: { slug, name } };
}

let store: ReturnType<typeof openGreenRoomDatabase> | undefined;
let outcome: ProcessResult;
try {
  const { dataDir, requestId, persona } = readArguments();
  store = openGreenRoomDatabase({ dataDir, migrationsDir: resolve("migrations") });
  const result = replaceCurrentRoomCast(store.database, {
    expectedRevision: 0,
    requestId,
    personas: [persona],
  });
  outcome = { ok: true, sessionId: result.sessionId };
} catch (error) {
  outcome = {
    ok: false,
    error: error instanceof Error && /selection revision conflict/i.test(error.message)
      ? "selection revision conflict"
      : "cast replacement failed",
  };
} finally {
  try {
    store?.close();
  } catch {
    outcome = { ok: false, error: "cast replacement failed" };
  }
}

const serialized = JSON.stringify(outcome);
if (serialized.length > MAX_RESULT_LENGTH) {
  process.stdout.write('{"ok":false,"error":"cast replacement failed"}\n');
} else {
  process.stdout.write(`${serialized}\n`);
}
