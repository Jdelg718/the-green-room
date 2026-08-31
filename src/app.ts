import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

interface BuildAppOptions {
  readonly logger?: boolean;
  readonly publicDir?: string;
}

interface StaticAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: false,
  });
  const csrfToken = randomBytes(32).toString("base64url");
  const publicDir = resolve(options.publicDir ?? "public");
  const assets: Readonly<Record<string, StaticAsset>> = {
    "/": {
      body: readFileSync(resolve(publicDir, "index.html")),
      contentType: "text/html; charset=utf-8",
    },
    "/app.js": {
      body: readFileSync(resolve(publicDir, "app.js")),
      contentType: "text/javascript; charset=utf-8",
    },
    "/styles.css": {
      body: readFileSync(resolve(publicDir, "styles.css")),
      contentType: "text/css; charset=utf-8",
    },
  };

  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
    return payload;
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/bootstrap", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { csrfToken };
  });

  for (const [url, asset] of Object.entries(assets)) {
    app.get(url, async (_request, reply) => {
      reply.type(asset.contentType);
      return asset.body;
    });
  }

  return app;
}
