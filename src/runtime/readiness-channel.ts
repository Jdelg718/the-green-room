import { Socket } from "node:net";

export const CHALLENGE_FRAME_BYTES = 40;
export const READY_FRAME_BYTES = 44;
const MAX_FRAME_BYTES = 45;
const HEADER_BYTES = 8;
const TOKEN_BYTES = 32;
const MAGIC = Buffer.from([0x47, 0x52, 0x52, 0x44]);

function protocolError(): Error {
  return new Error("readiness_protocol_error");
}

export function parseChallengeFrame(frame: Buffer): Buffer {
  if (
    frame.length !== CHALLENGE_FRAME_BYTES
    || !frame.subarray(0, 4).equals(MAGIC)
    || frame[4] !== 1
    || frame[5] !== 1
    || frame.readUInt16BE(6) !== TOKEN_BYTES
  ) throw protocolError();
  return Buffer.from(frame.subarray(HEADER_BYTES));
}

export function buildReadyFrame(token: Buffer, pid: number): Buffer {
  if (token.length !== TOKEN_BYTES || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) {
    throw protocolError();
  }
  const frame = Buffer.alloc(READY_FRAME_BYTES);
  MAGIC.copy(frame, 0);
  frame[4] = 1;
  frame[5] = 2;
  frame.writeUInt16BE(TOKEN_BYTES + 4, 6);
  token.copy(frame, HEADER_BYTES);
  frame.writeUInt32BE(pid, HEADER_BYTES + TOKEN_BYTES);
  return frame;
}

export interface PackagedReadinessChannel {
  proveReady(): Promise<void>;
  close(): void;
}

export async function acquirePackagedReadinessChannel(fd = 3): Promise<PackagedReadinessChannel> {
  const socket = new Socket({ fd, readable: true, writable: true, allowHalfOpen: true });
  const chunks: Buffer[] = [];
  let received = 0;
  const challenge = await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      for (const chunk of chunks) chunk.fill(0);
      socket.destroy();
      reject(protocolError());
    };
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_FRAME_BYTES) {
        chunk.fill(0);
        fail();
        return;
      }
      chunks.push(Buffer.from(chunk));
      chunk.fill(0);
    });
    socket.once("end", () => {
      if (settled) return;
      settled = true;
      const assembled = Buffer.concat(chunks, received);
      try {
        resolve(parseChallengeFrame(assembled));
      } catch {
        socket.destroy();
        reject(protocolError());
      } finally {
        assembled.fill(0);
        for (const chunk of chunks) chunk.fill(0);
      }
    });
    socket.once("error", fail);
  });
  let consumed = false;
  return {
    async proveReady(): Promise<void> {
      if (consumed) throw protocolError();
      consumed = true;
      const frame = buildReadyFrame(challenge, process.pid);
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            if (error) reject(protocolError());
            else resolve();
          };
          socket.once("error", () => finish(protocolError()));
          socket.once("close", (hadError) => finish(hadError ? protocolError() : undefined));
          socket.end(frame);
        });
      } finally {
        frame.fill(0);
        challenge.fill(0);
        socket.destroy();
      }
    },
    close(): void {
      consumed = true;
      challenge.fill(0);
      socket.destroy();
    },
  };
}
