import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { CBM_ASSETS, CBM_VERSION } from "../../research/net/cbm-download.ts";
import type { RawInvocationResult } from "../../domain/run.ts";
import type { runProcess } from "../../util/exec.ts";
import { hardeningAdvice, icaclsHardenArgs, installCbm, tarCommand, writeCbmConfig } from "./install.ts";

const archive = Buffer.from("fake archive bytes");
const raw = (over: Partial<RawInvocationResult> = {}): RawInvocationResult => ({ exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...over });

/** A platform whose pinned asset is swapped for our fake bytes, so no real download happens. */
function withFakeAsset<T>(fn: () => Promise<T>): Promise<T> {
  const key = "linux-x64";
  const real = CBM_ASSETS[key];
  (CBM_ASSETS as Record<string, unknown>)[key] = { ...real, sha256: createHash("sha256").update(archive).digest("hex"), bytes: archive.length };
  return fn().finally(() => {
    (CBM_ASSETS as Record<string, unknown>)[key] = real;
  });
}

/** A fake `tar` that "extracts" the binary, and a fake program that reports a version. */
function fakeRun(opts: { version?: string; tarExit?: number; noBinary?: boolean } = {}): { run: typeof runProcess; calls: string[] } {
  const calls: string[] = [];
  const run = (async (o: { command: string; args: readonly string[]; cwd: string }): Promise<RawInvocationResult> => {
    calls.push(`${o.command} ${o.args.join(" ")}`);
    if (o.command === "tar") {
      if ((opts.tarExit ?? 0) !== 0) return raw({ exitCode: opts.tarExit ?? 1, stderr: "tar: damaged archive" });
      const into = `${o.cwd}/${o.args[o.args.indexOf("-C") + 1] as string}`; // the paths are relative to the install folder
      if (opts.noBinary !== true) {
        await mkdir(`${into}/nested`, { recursive: true });
        await writeFile(`${into}/nested/codebase-memory-mcp`, "#!/bin/sh\n");
      }
      return raw();
    }
    return raw({ stdout: `codebase-memory-mcp ${opts.version ?? CBM_VERSION}\n` });
  }) as unknown as typeof runProcess;
  return { run, calls };
}
const fetchOk = () => Promise.resolve(new Response(archive, { status: 200, headers: { "content-length": String(archive.length) } }));
const handshakeOk = () => Promise.resolve({ serverVersion: CBM_VERSION });
const base = async () => ({ dir: await mkdtemp(`${tmpdir()}/osa-cbminstall-`), platform: "linux", arch: "x64" });

test("install: download, verify, unpack, confirm the version, prove it starts; reports the settings to use (forward slashes)", async () => {
  const f = fakeRun();
  const r = await withFakeAsset(async () => installCbm({ ...(await base()), run: f.run, download: { fetchFn: fetchOk }, handshake: handshakeOk }));
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.equal(r.alreadyInstalled, false);
  assert.match(r.binaryPath ?? "", /\/bin\/nested\/codebase-memory-mcp$/, "found even when the archive nests it");
  assert.ok(!(r.binaryPath ?? "").includes(String.fromCharCode(92)));
  assert.match(r.steps.join(" "), /verified its SHA-256/);
  assert.deepEqual(r.config?.index.cbm, { binaryPath: r.binaryPath, workDir: r.workDir });
  assert.equal(r.config?.index.engine, "cbm");
  assert.ok(f.calls.some((c) => c.startsWith("tar -xzf ")), "tar.gz archives use -xzf");
  const tarCall = f.calls.find((c) => c.startsWith("tar ")) ?? "";
  assert.doesNotMatch(tarCall, /[A-Za-z]:/, "tar gets relative paths only: GNU tar reads a drive letter as a remote host");
  assert.doesNotMatch(tarCall, /(^| )\//, "and no absolute path");
  assert.match(tarCall, /^tar -xzf download\/[^ ]+ -C bin$/);
});

test("install: an existing installation of the pinned version is reused (no download); --force replaces it", async () => {
  const b = await base();
  const first = await withFakeAsset(async () => installCbm({ ...b, run: fakeRun().run, download: { fetchFn: fetchOk }, handshake: handshakeOk }));
  assert.equal(first.ok, true);
  let downloads = 0;
  const counting = () => (downloads++, fetchOk());
  const again = await withFakeAsset(async () => installCbm({ ...b, run: fakeRun().run, download: { fetchFn: counting }, handshake: handshakeOk }));
  assert.equal(again.alreadyInstalled, true);
  assert.equal(downloads, 0);
  const forced = await withFakeAsset(async () => installCbm({ ...b, force: true, run: fakeRun().run, download: { fetchFn: counting }, handshake: handshakeOk }));
  assert.equal(forced.alreadyInstalled, false);
  assert.equal(downloads, 1);
});

test("install: every failure is reported, not thrown, and installs nothing it cannot vouch for", async () => {
  const b = await base();
  const tampered = () => Promise.resolve(new Response("something else", { status: 200 }));
  const mismatch = await withFakeAsset(async () => installCbm({ ...b, run: fakeRun().run, download: { fetchFn: tampered }, handshake: handshakeOk }));
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.problems[0] ?? "", /does not match the pinned checksum/);
  assert.equal(mismatch.config, null);
  const noBuild = await installCbm({ ...b, platform: "freebsd" });
  assert.match(noBuild.problems[0] ?? "", /no pinned codebase-memory-mcp build for freebsd\/x64/);
  const badTar = await withFakeAsset(async () => installCbm({ ...(await base()), run: fakeRun({ tarExit: 1 }).run, download: { fetchFn: fetchOk }, handshake: handshakeOk }));
  assert.match(badTar.problems[0] ?? "", /Unpacking the archive with tar failed.*damaged archive/);
  const empty = await withFakeAsset(async () => installCbm({ ...(await base()), run: fakeRun({ noBinary: true }).run, download: { fetchFn: fetchOk }, handshake: handshakeOk }));
  assert.match(empty.problems[0] ?? "", /did not contain codebase-memory-mcp/);
  const wrongVersion = await withFakeAsset(async () => installCbm({ ...(await base()), run: fakeRun({ version: "9.9.9" }).run, download: { fetchFn: fetchOk }, handshake: handshakeOk }));
  assert.match(wrongVersion.problems[0] ?? "", new RegExp(`did not report version ${CBM_VERSION.replaceAll(".", "\\.")}`));
});

test("install: a program that cannot start where it was put fails with the hardening advice (CBM refuses folders another account can write to)", async () => {
  const r = await withFakeAsset(async () => installCbm({ ...(await base()), run: fakeRun().run, download: { fetchFn: fetchOk }, handshake: () => Promise.reject(new Error("secure CLI coordination could not be created")) }));
  assert.equal(r.ok, false);
  assert.match(r.problems[0] ?? "", /could not start.*secure CLI coordination/);
  assert.match(r.problems[0] ?? "", /another account|lets another/);
  assert.match(r.problems[0] ?? "", /chmod -R go-w/, "on Linux the advice is a chmod");
  assert.notEqual(r.binaryPath, null, "it says where the program is, so nothing is lost");
});

test("writeCbmConfig: creates or merges osa.config.json keeping every other setting; refuses a file that is not JSON", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-cbmcfg-`);
  const cfg = { index: { engine: "cbm" as const, cbm: { binaryPath: "C:/x/bin/cbm.exe", workDir: "C:/x/work" } } };
  await writeCbmConfig(dir, cfg);
  assert.deepEqual(JSON.parse(await readFile(`${dir}/osa.config.json`, "utf8")), cfg);
  await writeFile(`${dir}/osa.config.json`, JSON.stringify({ memory: { enabled: false }, index: { topK: 3, cbm: { indexMode: "moderate" } } }));
  await writeCbmConfig(dir, cfg);
  assert.deepEqual(JSON.parse(await readFile(`${dir}/osa.config.json`, "utf8")), { memory: { enabled: false }, index: { topK: 3, engine: "cbm", cbm: { indexMode: "moderate", binaryPath: "C:/x/bin/cbm.exe", workDir: "C:/x/work" } } });
  await writeFile(`${dir}/osa.config.json`, "{ not json");
  await assert.rejects(writeCbmConfig(dir, cfg), /not valid JSON/);
  assert.equal(await readFile(`${dir}/osa.config.json`, "utf8"), "{ not json", "a broken file is left exactly as it was");
});

test("tarCommand: Windows unpacks with its own tar by full path (GNU tar cannot read zip); elsewhere plain tar", () => {
  assert.equal(tarCommand("win32", { SystemRoot: `C:${String.fromCharCode(92)}Windows` }), "C:/Windows/System32/tar.exe", "a backslash path is normalised");
  assert.equal(tarCommand("win32", {}), "C:/Windows/System32/tar.exe");
  assert.equal(tarCommand("linux", { SystemRoot: "ignored" }), "tar");
  assert.equal(tarCommand("darwin", {}), "tar");
});

test("Windows hardening: icacls arguments leave only this user, SYSTEM and Administrators; the advice prints the exact command and --harden; other systems get a chmod", () => {
  const env = { USERDOMAIN: "PC1", USERNAME: "ada" };
  const args = icaclsHardenArgs("C:/osa-cbm", env);
  assert.deepEqual(args, ["C:" + String.fromCharCode(92) + "osa-cbm", "/inheritance:r", "/grant:r", "PC1" + String.fromCharCode(92) + "ada:(OI)(CI)F", "NT AUTHORITY" + String.fromCharCode(92) + "SYSTEM:(OI)(CI)F", "BUILTIN" + String.fromCharCode(92) + "Administrators:(OI)(CI)F"]);
  assert.ok(!args.some((a) => /Everyone|Users:|Authenticated/.test(a)), "no broad group is granted anything");
  const win = hardeningAdvice("win32", "C:/osa-cbm", env);
  assert.match(win, /osa cbm install --harden/);
  const BSL = String.fromCharCode(92);
  assert.ok(win.includes(`icacls "C:${BSL}osa-cbm" /inheritance:r /grant:r "PC1${BSL}ada:(OI)(CI)F"`), win);
  assert.ok(hardeningAdvice("linux", "/opt/cbm", env).includes('chmod -R go-w "/opt/cbm"'));
});

test("install --harden on Windows runs icacls on the install folder only, before the start check; elsewhere it explains it is not needed", async () => {
  const calls: string[] = [];
  const run = (async (o: { command: string; args: readonly string[]; cwd: string }): Promise<RawInvocationResult> => {
    calls.push(`${o.command} ${o.args.join(" ")}`);
    if (o.command.endsWith("tar.exe") || o.command === "tar") {
      const into = `${o.cwd}/${o.args[o.args.indexOf("-C") + 1] as string}`;
      await mkdir(into, { recursive: true });
      await writeFile(`${into}/codebase-memory-mcp.exe`, "x");
      return raw();
    }
    return raw({ stdout: `codebase-memory-mcp ${CBM_VERSION}
` });
  }) as unknown as typeof runProcess;
  const key = "win32-x64";
  const real = CBM_ASSETS[key];
  (CBM_ASSETS as Record<string, unknown>)[key] = { ...real, sha256: createHash("sha256").update(archive).digest("hex"), bytes: archive.length };
  try {
    const dir = await mkdtemp(`${tmpdir()}/osa-harden-`);
    const order: string[] = [];
    const r = await installCbm({ dir, platform: "win32", arch: "x64", harden: true, run, download: { fetchFn: fetchOk }, handshake: () => (order.push("handshake"), Promise.resolve({ serverVersion: CBM_VERSION })) });
    assert.equal(r.ok, true, r.problems.join("; "));
    const ic = calls.find((c) => c.startsWith("icacls ")) ?? "";
    assert.ok(ic.includes("/inheritance:r"), ic);
    assert.ok(ic.includes(dir.split(String.fromCharCode(92)).join("/").split("/").join(String.fromCharCode(92))), "the install folder, and nothing else");
    assert.ok(r.steps.some((s) => /Restricted .* to your account/.test(s)));
  } finally {
    (CBM_ASSETS as Record<string, unknown>)[key] = real;
  }
  const f = fakeRun();
  const other = await withFakeAsset(async () => installCbm({ ...(await base()), harden: true, run: f.run, download: { fetchFn: fetchOk }, handshake: handshakeOk }));
  assert.equal(other.ok, true, other.problems.join("; "));
  assert.ok(other.steps.some((s) => /only needed on Windows/.test(s)), "elsewhere --harden explains itself");
  assert.ok(!f.calls.some((c) => c.startsWith("icacls")), "and runs nothing");
});
