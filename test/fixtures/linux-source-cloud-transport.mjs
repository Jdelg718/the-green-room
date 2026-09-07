import { registerHooks } from "node:module";

Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
const replacement = new URL("./linux-source-secure-http-transport.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url.endsWith("/dist/src/providers/secure-http-transport.js")
      ? { shortCircuit: true, url: replacement }
      : resolved;
  },
});
