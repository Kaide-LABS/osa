// `osa cbm install [--dir <path>] [--force] [--write-config] [--repo-dir <path>] [--json]` and `osa cbm status [--repo-dir <path>] [--json]`.

// Everything that belongs to the CBM plug-in is loaded with import() inside runCbmCommand, never at start-up: with the feature unused, none of its code is loaded
// (the static import graph from every entry point is tested for this, src/osa/modular-features.test.ts). Only types are imported here.
import type { InstallOptions, InstallReport } from "../code-index/cbm/install.ts";
import { ExitCode } from "../domain/errors.ts";
import { loadOsaConfig } from "../util/config-file.ts";

export type CbmCommandOptions =
  | { readonly action: "install"; readonly dir: string | null; readonly force: boolean; readonly harden: boolean; readonly writeConfig: boolean; readonly repoDir: string; readonly json: boolean }
  | { readonly action: "status"; readonly repoDir: string; readonly json: boolean };

export interface CbmCommandResult {
  readonly text: string;
  readonly exitCode: number;
}

export function renderInstallReport(r: InstallReport, wroteConfig: string | null): string {
  const lines = [`osa cbm install -- ${r.ok ? (r.alreadyInstalled ? "ALREADY INSTALLED" : "OK") : "FAILED"} (codebase-memory-mcp ${r.version})`, "", ...r.steps.map((s) => `  - ${s}`)];
  if (r.problems.length > 0) lines.push("", "Problems:", ...r.problems.map((p) => `  - ${p}`));
  if (r.config !== null) {
    lines.push("");
    if (wroteConfig !== null) lines.push(`Wrote the settings below into ${wroteConfig}. Search with: osa search "your question" --repo-dir <project>`);
    else lines.push("To use it, add this to osa.config.json (or run again with --write-config):");
    lines.push("", JSON.stringify(r.config, null, 2));
  }
  return `${lines.join("\n")}\n`;
}

/** Runs the cbm command. `deps` are test seams. */
export async function runCbmCommand(o: CbmCommandOptions, deps: { readonly install?: InstallOptions } = {}): Promise<CbmCommandResult> {
  const [{ binaryVersion, defaultInstallDir, exists, installCbm, writeCbmConfig }, { CbmSession }, { CBM_VERSION }] = await Promise.all([
    import("../code-index/cbm/install.ts"),
    import("../code-index/cbm/session.ts"),
    import("../research/net/cbm-download.ts"),
  ]);
  if (o.action === "install") {
    const report = await installCbm({ ...(o.dir !== null ? { dir: o.dir } : { dir: defaultInstallDir() }), ...(o.force ? { force: true } : {}), ...(o.harden ? { harden: true } : {}), ...(deps.install ?? {}) });
    let wrote: string | null = null;
    let extra = "";
    if (report.ok && o.writeConfig && report.config !== null) {
      try {
        wrote = await writeCbmConfig(o.repoDir, report.config);
      } catch (err) {
        extra = `\nCould not write the settings: ${err instanceof Error ? err.message : String(err)}\n`;
      }
    }
    return { text: o.json ? `${JSON.stringify({ ...report, wrote_config: wrote }, null, 2)}\n` : renderInstallReport(report, wrote) + extra, exitCode: report.ok ? ExitCode.OK : ExitCode.PREFLIGHT_FAILED };
  }
  const loaded = await loadOsaConfig(o.repoDir);
  const { binaryPath, workDir } = loaded.config.index.cbm;
  const out: { engine: string; binaryPath: string; workDir: string; installed: boolean; version: string | null; pinned: string; starts: boolean; problems: string[] } = {
    engine: loaded.config.index.engine, binaryPath, workDir, installed: false, version: null, pinned: CBM_VERSION, starts: false, problems: [],
  };
  if (binaryPath === "" || workDir === "") out.problems.push("index.cbm.binaryPath and index.cbm.workDir are not set. Run `osa cbm install --write-config`.");
  else if (!(await exists(binaryPath))) out.problems.push(`No program at ${binaryPath}. Run \`osa cbm install\`.`);
  else {
    out.installed = true;
    out.version = await binaryVersion(binaryPath, { binaryPath, workDir });
    if (out.version === null) out.problems.push("The program did not answer --version.");
    else if (!out.version.includes(CBM_VERSION)) out.problems.push(`The installed version (${out.version}) is not the one OSA was evaluated against (${CBM_VERSION}).`);
    try {
      const s = await CbmSession.open({ binaryPath, workDir }, { handshakeMs: 60_000 });
      await s.close();
      out.starts = true;
    } catch (err) {
      out.problems.push(`It does not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (out.engine !== "cbm") out.problems.push('index.engine is not "cbm", so searches use the local index.');
  const ok = out.installed && out.starts && out.problems.every((p) => p.startsWith("index.engine"));
  const text = o.json
    ? `${JSON.stringify(out, null, 2)}\n`
    : [`osa cbm status -- ${ok ? "READY" : "NOT READY"}`, `  engine: ${out.engine}`, `  program: ${binaryPath === "" ? "(not set)" : binaryPath}${out.version !== null ? ` -- ${out.version}` : ""}`, `  starts: ${out.starts ? "yes" : "no"}`, ...out.problems.map((p) => `  ! ${p}`)].join("\n") + "\n";
  return { text, exitCode: ok ? ExitCode.OK : ExitCode.PREFLIGHT_FAILED };
}
