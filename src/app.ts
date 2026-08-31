import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

import {
  registerApiRoutes,
  type ApiRoutesOptions,
} from "./api/routes.js";

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

interface BuildAppOptions
  extends Omit<ApiRoutesOptions, "allowedOrigin" | "csrfToken"> {
  readonly allowedOrigin?: string;
  readonly logger?: boolean;
  readonly publicDir?: string;
}

interface StaticAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    exposeHeadRoutes: false,
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

  registerApiRoutes(app, {
    allowedOrigin: options.allowedOrigin ?? "http://127.0.0.1:8787",
    csrfToken,
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.sseHeartbeatMs === undefined
      ? {}
      : { sseHeartbeatMs: options.sseHeartbeatMs }),
    ...(options.ssePollIntervalMs === undefined
      ? {}
      : { ssePollIntervalMs: options.ssePollIntervalMs }),
    ...(options.sseQueueLimit === undefined
      ? {}
      : { sseQueueLimit: options.sseQueueLimit }),
    ...(options.onSseClientCountChange === undefined
      ? {}
      : { onSseClientCountChange: options.onSseClientCountChange }),
    ...(options.onSseQueueSizeChange === undefined
      ? {}
      : { onSseQueueSizeChange: options.onSseQueueSizeChange }),
    ...(options.onSseResponse === undefined
      ? {}
      : { onSseResponse: options.onSseResponse }),
  });

  for (const [url, asset] of Object.entries(assets)) {
    app.get(url, async (_request, reply) => {
      reply.type(asset.contentType);
      return asset.body;
    });
  }

  return app;
}
