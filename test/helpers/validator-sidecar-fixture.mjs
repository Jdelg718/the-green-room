#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { basename } from "node:path";

const args = process.argv.slice(2);
const archivePath = args[4];
if (
  args.length !== 5 ||
  args[0] !== "validate" ||
  args[1] !== "--format" ||
  args[2] !== "json" ||
  args[3] !== "--" ||
  typeof archivePath !== "string"
) {
  process.stdout.write('{"report_version":"1","valid":false,"loadable":false,"errors":[{"code":"bad_arguments","message":"bad arguments"}],"warnings":[],"runtime_files":[],"diagnostics_truncated":false,"diagnostics_omitted":0,"prompt_sha256":null,"prompt_utf8_bytes":null}\n');
  process.exitCode = 1;
} else {
  const mode = basename(archivePath);
  const report = ({ valid = true, version = "1", code = "fixture_error" } = {}) => ({
    diagnostics_omitted: 0,
    diagnostics_truncated: false,
    errors: valid ? [] : [{ code, message: `SECRET prompt and path ${archivePath}`, path: archivePath }],
    loadable: valid,
    prompt_sha256: valid ? createHash("sha256").update(mode).digest("hex") : null,
    prompt_utf8_bytes: valid ? mode.length : null,
    report_version: version,
    runtime_files: valid ? ["AGENTS.md", "BACKGROUND.md", "VOICE.md"] : [],
    valid,
    warnings: [],
  });

  const write = (value, exitCode = 0) => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    process.exitCode = exitCode;
  };

  if (mode.startsWith("delay-")) {
    const milliseconds = Number(mode.split("-")[1]);
    setTimeout(() => write(report()), milliseconds);
  } else if (mode === "invalid") {
    write(report({ valid: false, code: "invalid_zip" }), 1);
  } else if (mode === "malformed") {
    process.stdout.write("not json\n");
  } else if (mode === "stdout-oversized") {
    process.stdout.write("x".repeat(20 * 1024 + 1));
  } else if (mode === "stderr-oversized") {
    process.stderr.write("x".repeat(8 * 1024 + 1));
    write(report());
  } else if (mode === "invalid-utf8") {
    process.stdout.write(Buffer.from([0xff, 0xfe]));
  } else if (mode === "hang") {
    setInterval(() => {}, 10_000);
  } else if (mode === "descendant-survival") {
    const marker = `${archivePath}.marker`;
    const ready = `${archivePath}.ready`;
    spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs'); const [ready,marker]=process.argv.slice(1); process.on('SIGTERM',()=>{}); fs.writeFileSync(ready,'ready'); setTimeout(()=>fs.writeFileSync(marker,'survived'),800); setInterval(()=>{},10000);",
        ready,
        marker,
      ],
      { stdio: "ignore" },
    );
    setInterval(() => {}, 10_000);
  } else if (mode === "exit-2") {
    write(report({ valid: false }), 2);
  } else if (mode === "contradict-valid") {
    write(report(), 1);
  } else if (mode === "contradict-invalid") {
    write(report({ valid: false }), 0);
  } else if (mode === "unknown-version") {
    write(report({ version: "2" }));
  } else if (mode === "array") {
    write([]);
  } else if (mode === "unknown-field") {
    write({ ...report(), prompt: "SECRET prompt text" });
  } else if (mode === "signal") {
    process.kill(process.pid, "SIGTERM");
  } else if (mode === "env") {
    const forbidden = [
      "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT",
      "PYTHONWARNINGS", "PYTHONBREAKPOINT", "PYTHONUSERBASE", "PYTHONEXECUTABLE",
      "PEX_ROOT", "PEX_PATH", "PEX_PYTHON", "PEX_PYTHON_PATH", "PEX_TOOLS",
      "PEX_INHERIT_PATH", "PEX_RC", "SECRET_SIDE_CAR_TEST",
    ];
    const dirty = forbidden.some((name) => process.env[name] !== undefined && process.env[name] !== "")
      || process.env.PEX_IGNORE_RCFILES !== "1";
    write(report({ valid: !dirty, code: "dirty_environment" }), dirty ? 1 : 0);
  } else if (mode === "stderr-secret") {
    process.stderr.write(`SECRET stderr ${archivePath}\n`);
    write(report({ valid: false, code: "safe_code" }), 1);
  } else {
    write(report());
  }
}
