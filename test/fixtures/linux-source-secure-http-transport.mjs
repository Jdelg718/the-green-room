import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";

const fixturePort = Number(process.env.GREENROOM_TEST_OPENROUTER_PORT);
const fixtureCa = process.env.GREENROOM_TEST_OPENROUTER_CA;
if (!Number.isSafeInteger(fixturePort) || fixturePort < 1 || fixturePort > 65_535 || fixtureCa === undefined) {
  throw new Error("linux source cloud fixture configuration is invalid");
}
const ca = readFileSync(fixtureCa);

export function createSecureHttpTransport() {
  return {
    request(plan, signal) {
      return new Promise((resolve, reject) => {
        const request = httpsRequest({
          host: "127.0.0.1",
          port: fixturePort,
          servername: "openrouter.ai",
          ca,
          rejectUnauthorized: true,
          method: plan.method,
          path: plan.path,
          headers: plan.headers,
        }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve({
            status: response.statusCode ?? 500,
            headers: Object.fromEntries(Object.entries(response.headers).flatMap(([name, value]) =>
              value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]]
            )),
            body: Uint8Array.from(Buffer.concat(chunks)),
          }));
        });
        request.once("error", reject);
        signal?.addEventListener("abort", () => request.destroy(new Error("fixture aborted")), { once: true });
        if (plan.body !== undefined) request.write(plan.body);
        request.end();
      });
    },
  };
}
