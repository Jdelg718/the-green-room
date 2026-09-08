import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plistParser = require("plist") as { parse(source: string): Record<string, unknown> };
const { DOMParser } = require("@xmldom/xmldom") as {
  DOMParser: new (options: { errorHandler: { warning(message: string): never; error(message: string): never; fatalError(message: string): never } }) => { parseFromString(source: string, type: string): unknown };
};

function parseStrict(source: string): Record<string, unknown> {
  const reject = (message: string): never => { throw new Error(message); };
  new DOMParser({ errorHandler: { warning: reject, error: reject, fatalError: reject } }).parseFromString(source, "application/xml");
  return plistParser.parse(source);
}

export function parsePlistFile(path: string): Record<string, unknown> {
  return parseStrict(readFileSync(path, "utf8"));
}

export function parsePlistInput(input: Buffer): Record<string, unknown> {
  return parseStrict(input.toString("utf8"));
}
