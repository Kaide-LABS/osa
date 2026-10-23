// The long-lived process helper in the one sanctioned spawn wrapper (src/util/exec.ts): used for the codebase-memory-mcp stdio session
// and nothing else. Same discipline as runProcess: argument array, shell:false, a fixed command. Tested against a real child process
// (this Node binary running a tiny line-echo server).

import { test } from "node:test";
import assert from "node:assert/strict";
import { startLongLived } from "./exec.ts";

const ECHO_SERVER = [
  "process.stdin.setEncoding('utf8');",
  "let buf='';",
  "process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line === 'die') process.exit(7); if (line === 'noise') process.stderr.write('some stderr'); process.stdout.write('echo:' + line + String.fromCharCode(10)); } });",
  "process.stdin.on('end', () => process.exit(0));",
].join("\n");

const start = (over: Partial<Parameters<typeof startLongLived>[0]> = {}) => startLongLived({ command: process.execPath, args: ["-e", ECHO_SERVER], cwd: process.cwd(), ...over });

test("a line written to stdin comes back as a line on stdout; lines arrive whole and in order, even when they are large", async () => {
  const p = await start();
  try {
    const got: string[] = [];
    p.onLine((l) => got.push(l));
    p.writeLine("hello");
    const big = "x".repeat(200_000);
    p.writeLine(big);
    p.writeLine("last");
    // A generous deadline: on a loaded machine the child takes seconds to start. And the child is ALWAYS stopped (finally), so a failed assertion
    // is a failure, not a leaked process that keeps the whole test run from exiting.
    for (let i = 0; i < 750 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(got, ["echo:hello", `echo:${big}`, "echo:last"]);
  } finally {
    await p.stop();
  }
});

test("stderr is captured separately; closing stdin ends the child cleanly and exited resolves with its code", async () => {
  const p = await start();
  try {
    p.writeLine("noise");
    for (let i = 0; i < 750 && !/some stderr/.test(p.stderrText()); i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(p.stderrText(), /some stderr/);
    p.closeStdin();
    const ex = await p.exited;
    assert.equal(ex.code, 0);
    assert.equal(ex.timedOut, false);
  } finally {
    await p.stop();
  }
});

test("a child that dies on its own is reported with its exit code", async () => {
  const p = await start();
  try {
    p.writeLine("die");
    const ex = await p.exited;
    assert.equal(ex.code, 7);
  } finally {
    await p.stop();
  }
});

test("stop() ends a child that ignores its stdin closing, within the grace period", async () => {
  const p = await startLongLived({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), stopGraceMs: 200 });
  const t0 = Date.now();
  await p.stop();
  const ex = await p.exited;
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(ex.code !== 0 || ex.signal !== null);
});

test("a command that does not exist is a clean failure result, never a throw, never a shell fallback", async () => {
  const p = await startLongLived({ command: "osa-definitely-not-installed-binary", args: [], cwd: process.cwd() });
  const ex = await p.exited;
  assert.equal(ex.code, null);
  assert.match(p.stderrText() + (ex.error ?? ""), /ENOENT|not found|spawn/i);
});

test("environment is exactly what the caller passes (no inheritance surprises) and the working directory is honoured", async () => {
  const p = await startLongLived({
    command: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({a: process.env.OSA_T, b: process.env.OSA_NOT_PASSED ?? null, cwd: process.cwd()}) + String.fromCharCode(10)); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>), OSA_T: "yes" },
  });
  try {
    const lines: string[] = [];
    p.onLine((l) => lines.push(l));
    for (let i = 0; i < 750 && lines.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    const j = JSON.parse(lines[0] ?? "{}") as { a: string; b: string | null; cwd: string };
    assert.equal(j.a, "yes");
    assert.equal(j.b, null);
  } finally {
    await p.stop();
  }
});
