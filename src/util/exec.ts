// Implements PHASE_1_SPEC.md §6.1
//
// The single sanctioned child-process wrapper. This is the ONLY module in the codebase permitted
// to import `node:child_process` -- boundary/reviewer tooling greps for it and fails any other
// file that imports this module directly (PHASE_1_SPEC.md §8 acceptance check #8).
//
// Windows note (AUTONOMOUS CRITIQUE adjustment, see the executor's handoff): npm's global install
// mechanism on Windows publishes CLI tools (including both provider CLIs this project drives) as
// `.cmd` launcher shims, not `.exe` files. Node's `child_process.spawn` cannot execute a `.cmd`/
// `.bat` file at all when `shell: false` -- it fails with `ENOENT` regardless of whether the
// command is genuinely on PATH -- which is a real, OS-level limitation, not a bug in this file
// [observed locally: `spawn("claude", ["--version"], { shell: false })` -> `ENOENT`, while `where
// claude` resolves it to `...\npm\claude.cmd`]. `shell: false` for the primary spawn stays exactly
// as specified (arguments are never handed to a shell for metacharacter interpretation). The
// narrow fallback below only engages when that primary spawn fails with `ENOENT` on `win32`, and
// relaunches through `cmd.exe /d /s /v:OFF /c` -- so the fallback lets cmd.exe do its own
// PATH+PATHEXT resolution (finding the `.cmd` shim, exactly as a human typing the same command at
// a prompt would) without reintroducing shell-injection risk through argument content.
//
// Why the fallback builds the command line itself (bug fix; see `buildWindowsCmdRelaunch`): the
// fallback originally passed `["/d", "/s", "/c", command, ...args]` as a normal argv array with
// `shell: false`, and simply *refused* to engage whenever any argument contained one of
// `& | < > ^ % " \r \n`. Both halves of that were wrong for arguments containing `"`:
//
//   * Node/libuv quote an argv array using the MSVCRT/`CommandLineToArgvW` convention, in which an
//     embedded quote is escaped as `\"`. cmd.exe has never understood `\"` -- it is a *different*
//     grammar, and it tracks quote state by counting raw `"` characters. Handing a `\"`-escaped
//     line to `cmd /c` therefore desynchronises cmd's quote parity, which is precisely the
//     dialect mismatch behind CVE-2024-27980 / CVE-2024-24576 ("BatBadBut").
//   * The blanket refusal meant the `codex` adapter -- whose `-c key="value"` config overrides
//     unavoidably contain literal `"` (Codex's own documented override syntax) -- could never be
//     relaunched at all, so every real Codex turn failed with `ENOENT` on Windows while
//     `doctor --providers` still reported it healthy (its preflight probes use unquoted args).
//
// The fix builds the full cmd.exe command line as one correctly-escaped string and spawns it with
// `windowsVerbatimArguments: true`, bypassing libuv's argv quoting entirely. See
// `quoteForWindowsCommandLine` for the escaping rule and `CMD_IRREDUCIBLY_UNSAFE_CHARS` for the
// (now much narrower, but still genuinely fail-safe) set of characters the fallback still refuses.
//
// exitCode:null caveat on the fallback path (disclosed in Step 12's adversarial review, approved
// commit e389620): PHASE_1_SPEC.md §6.1's contract that a spawn error resolves with
// `exitCode: null` describes the non-Windows-fallback path. When the cmd.exe relaunch above
// engages and the underlying command genuinely isn't found by cmd.exe's own PATH+PATHEXT
// resolution either, the result comes from cmd.exe's own `close` event, not from a second spawn
// error -- so `exitCode` is cmd.exe's real (non-null) exit code, observed on this machine as `1`.
// That is the same code some legitimate business-logic outcomes already use elsewhere in this
// codebase (e.g. `codex login status` returning `1` for "not logged in"), and there is no
// reliable, locale-independent numeric signal to tell the two apart; parsing cmd.exe's own
// (potentially localized) stderr text to disambiguate would be exactly the non-deterministic
// heuristic the I2 invariant (PRD §7) forbids, so this file does not attempt it. This is a
// documented, deliberate, narrower exception to §6.1 on Windows, not an oversight. Any caller
// that needs a reliable "is this CLI even installed" signal on Windows must not rely on
// `exitCode === null` specifically -- treat any non-zero exit code as the failure signal, which
// every current caller already does.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { RawInvocationResult } from "../domain/run.ts";

/** Options for {@link runProcess}. */
export interface RunProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string | null;
  /** Required: no default. A turn without an explicit timeout is precisely FM7 (PRD §9). */
  readonly timeoutMs: number;
  /** Default 10_000_000 bytes, applied independently to stdout and stderr. */
  readonly maxOutputBytes?: number;
  /**
   * Never relaunch through `cmd.exe` when the command is not found. For native executables at a fixed path (trim-1,
   * codebase-memory-mcp): there is no `.cmd` shim to resolve, and "no shell, ever" is then literally true.
   */
  readonly noShellFallback?: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 10_000_000;
const SIGKILL_GRACE_MS = 5000;

interface AccumState {
  readonly bytes: number;
  readonly truncated: boolean;
}

function appendChunk(
  chunks: Buffer[],
  chunk: Buffer,
  state: AccumState,
  maxOutputBytes: number,
  streamLabel: "stdout" | "stderr",
): AccumState {
  if (state.truncated) {
    return state;
  }
  if (state.bytes + chunk.length > maxOutputBytes) {
    const remaining = Math.max(0, maxOutputBytes - state.bytes);
    if (remaining > 0) {
      chunks.push(chunk.subarray(0, remaining));
    }
    chunks.push(Buffer.from(`\n...[${streamLabel} truncated at ${maxOutputBytes} bytes]...\n`, "utf8"));
    return { bytes: maxOutputBytes, truncated: true };
  }
  chunks.push(chunk);
  return { bytes: state.bytes + chunk.length, truncated: false };
}

/**
 * The characters that genuinely cannot be made safe inside a `cmd.exe /c` command line, and so are
 * still refused outright rather than escaped (fail-safe: refuse, don't guess). This is deliberately
 * much narrower than the blanket `[&|<>^%"\r\n]` blocklist it replaces -- `& | < > ^` and `"` are
 * now *correctly handled* by {@link quoteForWindowsCommandLine} instead of being rejected.
 *
 * Each remaining character was verified empirically on Windows 11 (26200) by round-tripping it
 * through a real `%*`-forwarding `.cmd` shim, which is the exact shape of the npm launcher shims
 * this fallback exists to reach:
 *
 *   * `%` -- cmd.exe performs `%VAR%` expansion *before* the quote/caret processing phase, so it
 *     happens even inside a fully quoted token and cannot be suppressed by any quoting this
 *     function can emit [observed: `pct-%PATH%-end` arrived as `pct-C:\Users\hp\bin;...-end`].
 *     Rust's std works around this with a `%%cd:~,%` no-op-substring trick that depends on command
 *     extensions being enabled; this file refuses instead, which is strictly safer and needs no
 *     assumption about the inherited cmd.exe configuration.
 *   * `\r` / `\n` -- terminate or truncate the command line [observed: `lf-\n-end` arrived as
 *     `lf-`, `cr-\r-end` arrived as `cr--end`], so a trailing fragment could become a *second*
 *     command. This matches the same refusal in Rust std's own `make_bat_command_line`.
 *   * `\0` -- cannot appear in a Win32 command line at all.
 *
 * Note that `!` is *not* in this set: delayed expansion (`!VAR!`) is what would make it dangerous,
 * and the relaunch passes `/v:OFF` explicitly to guarantee it is disabled regardless of the
 * machine's `HKCU\Software\Microsoft\Command Processor\DelayedExpansion` registry setting
 * [verified: `bang-!PATH!-end` round-trips verbatim].
 */
const CMD_IRREDUCIBLY_UNSAFE_CHARS = /[%\r\n\0]/;

/**
 * Quotes one token for a Windows command line that will be parsed **twice**: first by cmd.exe's own
 * `/c` line grammar, and then by the ultimately-spawned program's `CommandLineToArgvW`/MSVCRT argv
 * parser (with, in the `.cmd`-shim case this fallback exists for, cmd.exe's `%*` raw-tail
 * forwarding in between -- so the same string is re-parsed by cmd a second time).
 *
 * The rule -- taken from Rust std's `append_bat_arg`, the implementation hardened in response to
 * CVE-2024-24576, and cross-checked against Node's `child_process` docs on `windowsVerbatimArguments`:
 *
 *   1. Wrap the whole token in `"` unconditionally. Everything inside a cmd.exe quoted region is
 *      inert, which is what neutralises `& | < > ^ ( )` without needing caret escapes at all.
 *   2. Escape an embedded `"` by **doubling** it (`""`), not as `\"`. Both parsers accept `""` as a
 *      literal quote, and -- critically -- doubling keeps cmd.exe's raw `"` count even, so the
 *      token never falls out of quoted context. `\"` is understood by the argv parser but *not* by
 *      cmd.exe, and using it here is the actual root cause of the bug this replaces.
 *   3. Double any run of backslashes that immediately precedes a `"` (embedded or the closing one),
 *      per the documented `CommandLineToArgvW` rule that `2n` backslashes before a quote mean `n`
 *      literal backslashes. Backslashes elsewhere are literal and are left alone, so ordinary
 *      Windows paths (`C:\Users\hp\OSA`) pass through untouched.
 *
 * Verified by round-tripping every case in `exec.test.ts` through both a real `%*`-forwarding
 * `.cmd` shim and a directly-spawned `.exe`, in both cases recovering the argv byte-for-byte.
 */
export function quoteForWindowsCommandLine(arg: string): string {
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
    } else {
      if (ch === '"') {
        // 2n backslashes before the literal quote we are about to double.
        out += "\\".repeat(backslashes);
        out += '"';
      }
      backslashes = 0;
    }
    out += ch;
  }
  // 2n backslashes before the closing quote, so a trailing `\` cannot escape it.
  return `${out}${"\\".repeat(backslashes)}"`;
}

/**
 * Builds the `cmd.exe` argv for the ENOENT relaunch, or returns `null` if no safe command line can
 * be constructed -- in which case the caller must *not* relaunch and surfaces the original spawn
 * error instead.
 *
 * The returned array is meant to be spawned with `windowsVerbatimArguments: true`: the final
 * element is a single pre-escaped string, and letting libuv re-quote it would reintroduce exactly
 * the `\"` dialect mismatch this function exists to avoid.
 *
 * `/d` skips AutoRun commands, `/v:OFF` disables delayed (`!VAR!`) expansion, and `/s` makes cmd
 * strip only the outermost quote pair and treat the remainder verbatim -- which is why the whole
 * line is wrapped in one extra pair of quotes here, leaving every individual token still quoted.
 */
export function buildWindowsCmdRelaunch(command: string, args: readonly string[]): readonly string[] | null {
  // Windows file names can contain neither `"` nor a trailing `\` (the latter would escape the
  // closing quote of the command token), so refusing them costs nothing real and keeps the command
  // token unambiguous. Same guard as Rust std's `make_bat_command_line`.
  if (command.includes('"') || command.endsWith("\\") || CMD_IRREDUCIBLY_UNSAFE_CHARS.test(command)) {
    return null;
  }
  if (args.some((a) => CMD_IRREDUCIBLY_UNSAFE_CHARS.test(a))) {
    return null;
  }
  const line = [command, ...args].map(quoteForWindowsCommandLine).join(" ");
  return ["/d", "/s", "/v:OFF", "/c", `"${line}"`];
}

function isEnoent(err: Error): boolean {
  return "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Spawns `command`/`args` with `shell: false` (mandatory -- a shell would reintroduce
 * argument-injection and make an adapter's argv contract meaningless) and resolves with a
 * {@link RawInvocationResult}. Never rejects: a spawn failure (e.g. `ENOENT`, the CLI is not
 * installed) resolves with `exitCode: null` and the error text in `stderr`, so callers cannot
 * confuse "not installed" with a thrown bug.
 *
 * `allowWindowsCmdFallback` gates the one-time `cmd.exe` relaunch described at the top of this
 * file; it is only ever `false` on the relaunch attempt itself, preventing a retry loop. Note
 * that the `exitCode: null` guarantee above holds for the initial spawn's own error path, but not
 * for a fallback relaunch that itself fails to find the command: see the "exitCode:null caveat"
 * paragraph in the file-level comment for why that case surfaces a real, non-null exit code
 * instead.
 */
function spawnOnce(
  o: RunProcessOptions,
  command: string,
  args: readonly string[],
  allowWindowsCmdFallback: boolean,
  windowsVerbatimArguments = false,
): Promise<RawInvocationResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const maxOutputBytes = o.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: o.cwd,
        env: o.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        timedOut: false,
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let sigkillTimer: NodeJS.Timeout | null = null;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutState: AccumState = { bytes: 0, truncated: false };
    let stderrState: AccumState = { bytes: 0, truncated: false };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutState = appendChunk(stdoutChunks, chunk, stdoutState, maxOutputBytes, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrState = appendChunk(stderrChunks, chunk, stderrState, maxOutputBytes, "stderr");
    });

    // [DET, FM7] never inherit the parent TTY on stdin.
    if (typeof o.stdin === "string") {
      child.stdin?.end(o.stdin, "utf8");
    } else {
      child.stdin?.end();
    }

    const killTimer: NodeJS.Timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, o.timeoutMs);

    function settle(exitCode: number | null, signal: NodeJS.Signals | null, stderrOverride?: string): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      if (sigkillTimer !== null) {
        clearTimeout(sigkillTimer);
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: stderrOverride ?? Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: Date.now() - start,
        timedOut,
      });
    }

    child.on("error", (err) => {
      // Asynchronous spawn failures (e.g. ENOENT) surface here rather than as a thrown exception.
      const relaunchArgs =
        allowWindowsCmdFallback && process.platform === "win32" && isEnoent(err)
          ? buildWindowsCmdRelaunch(command, args)
          : null;
      if (relaunchArgs !== null) {
        settled = true;
        clearTimeout(killTimer);
        if (sigkillTimer !== null) {
          clearTimeout(sigkillTimer);
        }
        // `windowsVerbatimArguments: true` -- `relaunchArgs`'s last element is already a fully
        // escaped cmd.exe line; letting libuv re-quote it would corrupt it (see the file header).
        resolve(spawnOnce(o, "cmd.exe", relaunchArgs, false, true));
        return;
      }
      settle(null, null, err.message);
    });

    child.on("close", (code, signal) => {
      settle(code, signal);
    });
  });
}

/**
 * Spawns `o.command`/`o.args` and resolves with a {@link RawInvocationResult}. See the file-level
 * comment for the narrow, safety-gated Windows `.cmd`/`.bat` shim fallback this delegates to.
 *
 * [DET, PRD §9 FM7] stdin is never inherited from the parent TTY: a string payload is written and
 * closed, and when no payload is given stdin is closed immediately. A provider CLI that tries to
 * prompt therefore reads EOF and fails fast instead of hanging the run.
 *
 * [DET, PRD §9 FM7] `timeoutMs` is mandatory and always armed: on expiry the process is sent
 * `SIGTERM`, escalated to `SIGKILL` after a 5 second grace, and the result always carries
 * `timedOut: true` regardless of what exit code the process eventually reports.
 */
export function runProcess(o: RunProcessOptions): Promise<RawInvocationResult> {
  return spawnOnce(o, o.command, o.args, o.noShellFallback !== true);
}

/**
 * Runs `commandLine` through the platform shell with the parent's stdio inherited, so an interactive
 * program (the operator's `$VISUAL`/`$EDITOR`) can take over the terminal. This is the one deliberate
 * exception to "stdin is never inherited" (PRD §9 FM7): that rule exists to stop *provider CLIs* from
 * hanging a headless run, whereas this is invoked only at OSA's lock prompt, which is itself interactive
 * by definition, and the command line is composed from the operator's own editor setting plus a path
 * OSA created. Resolves with the exit code (`null` if it could not be started).
 */
export function runInteractive(commandLine: string, cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(commandLine, { cwd, stdio: "inherit", shell: true });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}

// ---- long-lived child (the codebase-memory-mcp stdio session) --------------------------------------------------------------

/** Options of {@link startLongLived}. */
export interface LongLivedOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The child's complete environment. Default: inherit. */
  readonly env?: Readonly<Record<string, string>>;
  /** After stdin is closed, how long a child gets to exit before it is killed. Default 3000 ms. */
  readonly stopGraceMs?: number;
}

/** How a long-lived child ended. */
export interface LongLivedExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: false;
  /** Set when the child could not be started at all (ENOENT ...). */
  readonly error?: string;
}

/** A running child with a line-oriented stdout. */
export interface LongLived {
  /** Registers a handler for each complete stdout line (without the newline). Lines are delivered whole and in order. */
  onLine(handler: (line: string) => void): void;
  /** Writes `line` plus a newline to the child's stdin. */
  writeLine(line: string): void;
  closeStdin(): void;
  stderrText(): string;
  /** Closes stdin, waits up to `stopGraceMs`, then kills. Resolves when the child is gone. */
  stop(): Promise<void>;
  readonly exited: Promise<LongLivedExit>;
}

/**
 * Starts a child that stays alive across many requests. Same discipline as {@link runProcess}: an argument array, `shell: false`, a fixed
 * command, never a shell fallback; a command that cannot start is reported through `exited`, not thrown. Used only for the
 * codebase-memory-mcp session, whose start-up costs ~10 s and which would otherwise be paid on every query.
 */
export function startLongLived(o: LongLivedOptions): Promise<LongLived> {
  return new Promise((resolve) => {
    const handlers: ((line: string) => void)[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBuf = "";
    let settleExit: (e: LongLivedExit) => void = () => undefined;
    const exited = new Promise<LongLivedExit>((r) => {
      settleExit = r;
    });
    let child: ChildProcess;
    try {
      child = spawn(o.command, [...o.args], { cwd: o.cwd, ...(o.env !== undefined ? { env: o.env } : {}), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      settleExit({ code: null, signal: null, timedOut: false, error: err instanceof Error ? err.message : String(err) });
      stderrChunks.push(Buffer.from(err instanceof Error ? err.message : String(err)));
      resolve(handle());
      return;
    }
    let ended = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdoutBuf += d;
      let i = stdoutBuf.indexOf("\n");
      while (i >= 0) {
        const line = stdoutBuf.slice(0, i).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(i + 1);
        for (const h of handlers) h(line);
        i = stdoutBuf.indexOf("\n");
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (Buffer.concat(stderrChunks).length < 1_000_000) stderrChunks.push(d);
    });
    child.on("error", (err) => {
      stderrChunks.push(Buffer.from(err.message));
      if (!ended) {
        ended = true;
        settleExit({ code: null, signal: null, timedOut: false, error: err.message });
      }
    });
    child.on("close", (code, signal) => {
      if (!ended) {
        ended = true;
        settleExit({ code, signal, timedOut: false });
      }
    });
    resolve(handle());

    function handle(): LongLived {
      return {
        onLine: (h) => void handlers.push(h),
        writeLine: (line) => void child?.stdin?.write(`${line}\n`),
        closeStdin: () => void child?.stdin?.end(),
        stderrText: () => Buffer.concat(stderrChunks).toString("utf8"),
        exited,
        stop: async () => {
          if (child === undefined || ended) return;
          child.stdin?.end();
          const grace = o.stopGraceMs ?? 3000;
          const timer = setTimeout(() => child.kill("SIGKILL"), grace);
          await exited;
          clearTimeout(timer);
        },
      };
    }
  });
}
