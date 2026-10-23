// A persistent stdio MCP session with the codebase-memory-mcp binary. Why a session and not `cbm cli <tool>` per call: every CLI call pays ~3.7 s
// of process start-up plus a ~7 s temporary-daemon start (measured on 0.12.1, Windows 11); one session pays ~11 s once, then ~30 ms per query.
//
// OSA owns how the binary is launched: a FIXED path from config (never looked up on PATH), an argument array, no shell (src/util/exec.ts is the
// only spawn wrapper; boundary rules B10-B12 enforce it), and a private environment:
//   CBM_CACHE_DIR      <workDir>/cache    indexes, settings
//   CBM_RUNTIME_DIR    <workDir>/run      daemon/CLI rendezvous (the documented fix for "ancestor directory is writable by another account")
//   CBM_ALLOWED_ROOT   <workDir>/shadow   index_repository refuses any path outside it
// It never runs `cbm install`, so none of the 45 supported agent clients' configs are touched.

import { startLongLived } from "../../util/exec.ts";
import type { LongLived } from "../../util/exec.ts";

/** Where CBM lives. `workDir` must sit where no ancestor directory is writable by another account (CBM refuses to start otherwise). */
export interface CbmPaths {
  readonly binaryPath: string;
  readonly workDir: string;
}

/** The result of one tool call. */
export interface CbmToolResult {
  readonly isError: boolean;
  /** The tool's text content (the human-readable form). */
  readonly text: string;
  /** The parsed `structuredContent` (present when the tool was asked for `format: "json"`). */
  readonly structured: unknown;
}

/** Thrown when the session cannot be used (could not start, handshake timed out, process died, request timed out). */
export class CbmSessionError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(message);
    this.name = "CbmSessionError";
    this.stderr = stderr;
  }
}

/** The environment CBM is started with: the caller's, plus OSA's private directories and a quiet log level. Pure. */
export function cbmEnvironment(paths: CbmPaths, base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  const w = paths.workDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return { ...env, CBM_CACHE_DIR: `${w}/cache`, CBM_RUNTIME_DIR: `${w}/run`, CBM_ALLOWED_ROOT: `${w}/shadow`, CBM_LOG_LEVEL: "warn" };
}

/** Options of {@link CbmSession.open}. */
export interface OpenOptions {
  readonly startFn?: typeof startLongLived;
  /** Handshake timeout (default 90 s: first start also starts a daemon). */
  readonly handshakeMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface Pending {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** One live session. Not safe to share between runs: open one per run, close it in a `finally`. */
export class CbmSession {
  private readonly proc: LongLived;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private died: string | null = null;
  serverVersion = "unknown";

  private constructor(proc: LongLived) {
    this.proc = proc;
    proc.onLine((line) => this.onLine(line));
    void proc.exited.then((e) => {
      this.died = e.error ?? `codebase-memory-mcp exited (code ${String(e.code)}${e.signal !== null ? `, signal ${e.signal}` : ""})`;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new CbmSessionError(this.died, this.proc.stderrText()));
        this.pending.delete(id);
      }
    });
  }

  /** Starts the binary and completes the MCP handshake. Throws {@link CbmSessionError}. */
  static async open(paths: CbmPaths, opts: OpenOptions = {}): Promise<CbmSession> {
    const proc = await (opts.startFn ?? startLongLived)({ command: paths.binaryPath, args: [], cwd: paths.workDir, env: cbmEnvironment(paths, opts.env), stopGraceMs: 5000 });
    const session = new CbmSession(proc);
    try {
      const init = (await session.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "osa", version: "0" } }, opts.handshakeMs ?? 90_000)) as { serverInfo?: { version?: string } };
      session.serverVersion = init.serverInfo?.version ?? "unknown";
      session.notify("notifications/initialized");
      return session;
    } catch (err) {
      await session.close();
      throw err instanceof CbmSessionError ? err : new CbmSessionError(err instanceof Error ? err.message : String(err), proc.stderrText());
    }
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return; // log noise on stdout is ignored
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (p === undefined) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new CbmSessionError(msg.error.message ?? "MCP error"));
    else p.resolve(msg.result);
  }

  private notify(method: string): void {
    this.proc.writeLine(JSON.stringify({ jsonrpc: "2.0", method }));
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed || this.died !== null) return Promise.reject(new CbmSessionError(this.died ?? "the CBM session is closed", this.proc.stderrText()));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CbmSessionError(`codebase-memory-mcp did not answer ${method} within ${String(Math.round(timeoutMs / 1000))}s`, this.proc.stderrText()));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Calls a CBM tool. A tool-level error comes back as `isError: true` (not a throw); a dead session throws {@link CbmSessionError}. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<CbmToolResult> {
    const r = (await this.request("tools/call", { name: tool, arguments: args }, timeoutMs)) as { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown };
    return { isError: r.isError === true, text: (r.content ?? []).map((c) => c.text ?? "").join("\n"), structured: r.structuredContent ?? null };
  }

  get alive(): boolean {
    return !this.closed && this.died === null;
  }

  /** Ends the session (closes stdin, then kills after a grace period). Idempotent; never throws. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CbmSessionError("the CBM session was closed"));
      this.pending.delete(id);
    }
    try {
      await this.proc.stop();
    } catch {
      /* already gone */
    }
  }
}
