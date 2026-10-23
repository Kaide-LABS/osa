// Keeps an OSA-launched provider process from inheriting the OPERATOR's personal tool plugins (Suite 2 / Suite 5, live-verified).
//
// Codex CLI loads, for every `exec` call: the `apps` feature (a built-in `codex_apps` connector that carries its own web-search tool,
// independent of the `web_search` setting) and every MCP server in the operator's ~/.codex/config.toml (here, `node_repl`, a JavaScript/
// browser runtime that runs OUTSIDE the read-only sandbox). A call OSA made with web search "disabled" therefore still browsed. The
// adapters stay pure (they build argument arrays); this helper -- the one place that reads the operator's config -- adds the switches that
// turn those off, as an argument array (never a shell string; boundary rules B10-B12).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { ProviderId } from "../domain/run.ts";
import type { Invocation } from "../ports/provider-adapter.ts";

const SERVER_HEADER = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/;

/** Names of the MCP servers declared in a Codex `config.toml` (bare-key top-level tables only). Pure. */
export function parseMcpServerNames(toml: string): string[] {
  const names: string[] = [];
  for (const line of toml.split(/\r?\n/)) {
    const m = SERVER_HEADER.exec(line);
    if (m?.[1] !== undefined && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** `codex exec` switches that remove the apps connector and each named MCP server. Pure. */
export function codexIsolationArgs(serverNames: readonly string[]): string[] {
  return ["--disable", "apps", ...serverNames.flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`])];
}

/** Reads the operator's Codex MCP server names; a missing or unreadable config means none. */
export async function readCodexMcpServerNames(env: Readonly<Record<string, string | undefined>> = process.env): Promise<string[]> {
  const home = env["CODEX_HOME"] !== undefined && env["CODEX_HOME"] !== "" ? env["CODEX_HOME"] : `${homedir()}/.codex`;
  try {
    return parseMcpServerNames(await readFile(`${home}/config.toml`, "utf8"));
  } catch {
    return [];
  }
}

/** Adds the isolation switches to a Codex `exec` invocation (right after `exec`); anything else is returned unchanged. */
export async function isolateInvocation(provider: ProviderId, inv: Invocation, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Invocation> {
  if (provider !== "codex-cli" || inv.args[0] !== "exec") return inv;
  const names = await readCodexMcpServerNames(env);
  return { ...inv, args: ["exec", ...codexIsolationArgs(names), ...inv.args.slice(1)] };
}
