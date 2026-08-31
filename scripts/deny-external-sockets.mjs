import { writeFileSync } from "node:fs";
import { Socket } from "node:net";

const auditPath = process.env.GREENROOM_SOCKET_AUDIT_PATH;
if (auditPath !== undefined) {
  if (process.env.GREENROOM_ACCEPTANCE_FIXTURE !== "first-playable-v1") {
    throw new Error("socket audit is restricted to the first-playable acceptance fixture");
  }

  const audit = { installed: true, attempts: [] };
  const persist = () => {
    writeFileSync(auditPath, `${JSON.stringify(audit)}\n`, { mode: 0o600 });
  };
  persist();

  Socket.prototype.connect = function guardedConnect(...args) {
    const first = args[0];
    const target =
      first !== null && typeof first === "object"
        ? {
            host: typeof first.host === "string" ? first.host : null,
            path: typeof first.path === "string" ? first.path : null,
            port: typeof first.port === "number" ? first.port : null,
          }
        : { type: typeof first };
    audit.attempts.push(target);
    persist();
    throw new Error("outbound sockets are disabled during first-playable acceptance");
  };
}
