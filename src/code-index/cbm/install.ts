// `osa cbm install`: puts the pinned codebase-memory-mcp release on this machine, safely, and proves it can start.
//
//   1. download the pinned archive for this platform (src/research/net/cbm-download.ts: pinned hash, GitHub hosts only, discarded on any mismatch)
//   2. extract it with the system `tar` into <dir>/bin (argument array, no shell) and make the binary executable
//   3. run `--version` and require the pinned version
//   4. start a real session (the MCP handshake) in <dir>/work: CBM refuses to run beside a folder that grants write access to another account, and that
//      is found out HERE, with advice, instead of in the middle of a build
//
// OSA never edits another tool's configuration, never runs CBM's own `install`, and only writes into <dir> (and, with --write-config, osa.config.json).

import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CBM_VERSION, CbmDownloadError, cbmAssetFor, downloadVerified } from "../../research/net/cbm-download.ts";
import type { CbmAsset, DownloadDeps } from "../../research/net/cbm-download.ts";
import { runProcess } from "../../util/exec.ts";
import { CbmSession, cbmEnvironment } from "./session.ts";
import type { CbmPaths } from "./session.ts";

export interface InstallOptions {
  /** Install root; default `~/.osa/cbm`. */
  readonly dir?: string;
  /** Replace an existing installation. */
  readonly force?: boolean;
  /** Windows: restrict the install folder to this user, SYSTEM and Administrators with icacls (only the folder OSA created). */
  readonly harden?: boolean;
  readonly platform?: string;
  readonly arch?: string;
  readonly download?: DownloadDeps;
  readonly run?: typeof runProcess;
  /** Test seam: the handshake check. */
  readonly handshake?: (paths: CbmPaths) => Promise<{ readonly serverVersion: string }>;
}

export interface InstallReport {
  readonly ok: boolean;
  readonly version: string;
  readonly dir: string;
  readonly binaryPath: string | null;
  readonly workDir: string;
  readonly alreadyInstalled: boolean;
  /** What was done, in order, in plain words. */
  readonly steps: readonly string[];
  readonly problems: readonly string[];
  /** The osa.config.json settings that turn the engine on (forward slashes, JSON-safe). */
  readonly config: { readonly index: { readonly engine: "cbm"; readonly cbm: { readonly binaryPath: string; readonly workDir: string } } } | null;
}

const toPosix = (p: string): string => p.split(String.fromCharCode(92)).join("/");
/** The default install root. */
export const defaultInstallDir = (): string => toPosix(join(homedir(), ".osa", "cbm"));
const binaryName = (platform: string): string => (platform === "win32" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp");

/** The tar to unpack with: Windows' own bsdtar by full path (it reads zip), plain `tar` elsewhere (the macOS and Linux archives are tar.gz). Pure. */
export function tarCommand(platform: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (platform !== "win32") return "tar";
  return `${toPosix(env["SystemRoot"] ?? env["WINDIR"] ?? "C:/Windows")}/System32/tar.exe`;
}

async function findBinary(dir: string, name: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === name) return toPosix(join(dir, e.name));
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const nested = await findBinary(join(dir, e.name), name);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** Runs `<binary> --version`; returns its first line, or null. */
export async function binaryVersion(binaryPath: string, paths: CbmPaths, run: typeof runProcess = runProcess): Promise<string | null> {
  const r = await run({ command: binaryPath, args: ["--version"], cwd: paths.workDir, env: cbmEnvironment(paths), timeoutMs: 30_000, noShellFallback: true });
  return r.exitCode === 0 ? (r.stdout.trim().split(/\r?\n/)[0] ?? null) : null;
}

const BS = String.fromCharCode(92);

/** The `icacls` arguments that leave `dir` (and what it will contain) writable by this user, SYSTEM and Administrators only: what CBM requires. Pure. */
export function icaclsHardenArgs(dir: string, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const domain = env["USERDOMAIN"];
  const who = `${domain !== undefined && domain !== "" ? `${domain}${BS}` : ""}${env["USERNAME"] ?? "%USERNAME%"}`;
  return [dir.split("/").join(BS), "/inheritance:r", "/grant:r", `${who}:(OI)(CI)F`, `NT AUTHORITY${BS}SYSTEM:(OI)(CI)F`, `BUILTIN${BS}Administrators:(OI)(CI)F`];
}

/** What to do when CBM will not start where it was installed. Pure. */
export function hardeningAdvice(platform: string, dir: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const why =
    "codebase-memory-mcp refuses to start when its folder, or one above it, lets another account write to it (a fresh folder under C:" + BS + " inherits write access for every signed-in user).";
  if (platform === "win32") {
    const args = icaclsHardenArgs(dir, env).map((a, i) => (i === 0 || a.startsWith("/") ? a : `"${a}"`));
    return `${why} Run  osa cbm install --harden  to restrict ${dir} to your account, SYSTEM and Administrators, or do it yourself:  icacls "${icaclsHardenArgs(dir, env)[0] as string}" ${args.slice(1).join(" ")}`;
  }
  return `${why} Make ${dir} writable by you only (chmod -R go-w "${dir}"), and check that no folder above it is writable by other users, or choose another folder with --dir.`;
}

/** Installs (or verifies an existing installation of) the pinned CBM. Never throws for an expected problem: it reports it. */
export async function installCbm(o: InstallOptions = {}): Promise<InstallReport> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const dir = toPosix(o.dir ?? defaultInstallDir());
  const workDir = `${dir}/work`;
  const steps: string[] = [];
  const run = o.run ?? runProcess;
  const fail = (problem: string, binaryPath: string | null = null): InstallReport => ({ ok: false, version: CBM_VERSION, dir, binaryPath, workDir, alreadyInstalled: false, steps, problems: [problem], config: null });

  const asset: CbmAsset | null = cbmAssetFor(platform, arch);
  if (asset === null) return fail(`There is no pinned codebase-memory-mcp build for ${platform}/${arch}.`);

  // CBM needs its cache, runtime and allowed-root folders to exist before it starts (it fails with a generic message otherwise).
  for (const sub of ["cache", "run", "shadow"]) await mkdir(`${workDir}/${sub}`, { recursive: true });
  const paths = (binaryPath: string): CbmPaths => ({ binaryPath, workDir });
  const name = binaryName(platform);

  let binary = await findBinary(`${dir}/bin`, name);
  let alreadyInstalled = false;
  if (binary !== null && o.force !== true) {
    const v = await binaryVersion(binary, paths(binary), run);
    if (v !== null && v.includes(CBM_VERSION)) {
      alreadyInstalled = true;
      steps.push(`Found codebase-memory-mcp ${CBM_VERSION} already installed at ${binary}.`);
    }
  }

  if (!alreadyInstalled) {
    const archive = `${dir}/download/${asset.name}`;
    try {
      const got = await downloadVerified(asset, archive, o.download ?? {});
      steps.push(`Downloaded ${asset.name} (${String(Math.round(got.bytes / 1_000_000))} MB) and verified its SHA-256 against the pinned value.`);
    } catch (err) {
      return fail(err instanceof CbmDownloadError ? err.message : `The download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await rm(`${dir}/bin`, { recursive: true, force: true });
    await mkdir(`${dir}/bin`, { recursive: true });
    // Relative paths from the install folder: GNU tar (Git for Windows puts it first on PATH) reads "C:/x" as host "C" and path "/x". On Windows the zip is also
    // unpacked with the system's own tar (bsdtar, by full path): GNU tar cannot read zip archives at all.
    const tar = await run({ command: tarCommand(platform), args: [asset.kind === "zip" ? "-xf" : "-xzf", `download/${asset.name}`, "-C", "bin"], cwd: dir, timeoutMs: 120_000, noShellFallback: true });
    if (tar.exitCode !== 0) return fail(`Unpacking the archive with tar failed (exit ${String(tar.exitCode)}): ${(tar.stderr || tar.stdout).trim().slice(0, 200)}`);
    binary = await findBinary(`${dir}/bin`, name);
    if (binary === null) return fail(`The archive did not contain ${name}.`);
    if (platform !== "win32") await chmod(binary, 0o755);
    steps.push(`Unpacked ${name} into ${dir}/bin.`);
    await rm(`${dir}/download`, { recursive: true, force: true });
    const v = await binaryVersion(binary, paths(binary), run);
    if (v === null || !v.includes(CBM_VERSION)) return fail(`The installed program did not report version ${CBM_VERSION} (it said: ${v ?? "nothing"}).`, binary);
    steps.push(`The program reports ${v}.`);
  }

  const p = paths(binary as string);
  if (o.harden === true) {
    if (platform !== "win32") steps.push("--harden is only needed on Windows; on this system make sure the folder is writable by you only.");
    else {
      const ac = await run({ command: "icacls", args: icaclsHardenArgs(dir), cwd: dir, timeoutMs: 60_000, noShellFallback: true });
      if (ac.exitCode !== 0) return fail(`Restricting ${dir} with icacls failed (exit ${String(ac.exitCode)}): ${(ac.stderr || ac.stdout).trim().slice(0, 200)}`, binary);
      steps.push(`Restricted ${dir} to your account, SYSTEM and Administrators (icacls).`);
    }
  }
  try {
    const shake = await (o.handshake ?? (async (x: CbmPaths) => {
      const s = await CbmSession.open(x, { handshakeMs: 60_000 });
      const info = { serverVersion: s.serverVersion };
      await s.close();
      return info;
    }))(p);
    steps.push(`It started in ${workDir} and answered (server version ${shake.serverVersion}).`);
  } catch (err) {
    return fail(`The program is installed but could not start in ${workDir}: ${err instanceof Error ? err.message : String(err)}. ${hardeningAdvice(platform, dir)}`, binary);
  }
  return { ok: true, version: CBM_VERSION, dir, binaryPath: binary, workDir, alreadyInstalled, steps, problems: [], config: { index: { engine: "cbm", cbm: { binaryPath: binary as string, workDir } } } };
}

/** Merges the engine settings into `<repoDir>/osa.config.json` (creating it), keeping everything else. Refuses an unreadable file. */
export async function writeCbmConfig(repoDir: string, config: NonNullable<InstallReport["config"]>): Promise<string> {
  const path = `${repoDir}/osa.config.json`;
  let current: Record<string, unknown> = {};
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
    current = parsed as Record<string, unknown>;
  } catch (err) {
    const missing = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing) throw new Error(`${path} exists but is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it or add the settings by hand.`);
  }
  const index = typeof current["index"] === "object" && current["index"] !== null && !Array.isArray(current["index"]) ? (current["index"] as Record<string, unknown>) : {};
  const cbm = typeof index["cbm"] === "object" && index["cbm"] !== null && !Array.isArray(index["cbm"]) ? (index["cbm"] as Record<string, unknown>) : {};
  const merged = { ...current, index: { ...index, engine: config.index.engine, cbm: { ...cbm, binaryPath: config.index.cbm.binaryPath, workDir: config.index.cbm.workDir } } };
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return path;
}

/** True iff a file exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
