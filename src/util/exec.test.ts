// Implements PHASE_1_SPEC.md §1.6 / §6.1 -- exec.test.ts
//
// PHASE_1_SPEC.md's own test-file table (§1.6) does not list a dedicated exec.test.ts, and
// runProcess() is already exercised indirectly by every other suite (git.ts, preflight.ts,
// main.test.ts's real child-process invocations of `node`, `claude`, and `codex`). This file adds
// *direct*, black-box coverage of runProcess()'s own documented contract (§6.1), added by the
// Phase 1 reviewer specifically to close a gap: the Windows `.cmd`/`.bat`-shim relaunch fallback
// described in this module's own file-level comment (see exec.ts) had no dedicated test anywhere,
// despite being a real, unspecified-in-§6.1 behavioural addition with a security-relevant
// rationale (it exists precisely because `shell: false` -- which §6.1 calls mandatory -- cannot
// execute a `.cmd` launcher at all on Windows). This file pins down, with real spawns, both:
// (a) the contract §6.1 states outright (never rejects; a spawn error looks like a resolved
//     failure, not a thrown exception; a genuine ENOENT with shell-unsafe argument content is
//     never silently relaunched), and
// (b) the *actual observed* behaviour of the relaunch path on this platform for a safe-argument,
//     truly nonexistent command -- which is NOT the literal `exitCode: null` §6.1 step 6
//     describes, because cmd.exe itself resolves the sub-command lookup and reports its own exit
//     code (observed: `1`) rather than the parent spawn call ENOENT-ing. This is a genuine,
//     verified deviation from §6.1's literal text, flagged in the Phase 1 review rather than
//     silently left uncovered. It does not currently break any Phase 1 caller because every
//     consumer of RawInvocationResult in this codebase (see preflight.ts's parse* functions) keys
//     on `exitCode !== 0`, never on `exitCode === null` specifically -- but the distinction the
//     type signature (`exitCode: number | null`) was designed to carry is real, and a future
//     phase must not assume `null` is the only way "the command was not found" surfaces on
//     Windows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildWindowsCmdRelaunch, quoteForWindowsCommandLine, runProcess } from "./exec.ts";

const onlyWindows = { skip: process.platform !== "win32" };

/**
 * Creates a throwaway directory containing an npm-cmd-shim-shaped `mlfakecli.cmd` that forwards the
 * raw command tail via `%*` to a Node script echoing its own argv as JSON, and prepends that
 * directory to `PATH`.
 *
 * The shim shape matters: `%*` means the command line is re-parsed by cmd.exe a *second* time
 * before the argv parser ever sees it, which is the exact double-parse that makes naive `\"`
 * escaping exploitable (CVE-2024-24576 "BatBadBut"). A bare, extensionless command name is used
 * because that is what reproduces the real failure -- `CreateProcess` only appends `.exe`, never
 * the full `PATHEXT`, so Node's `shell: false` spawn of `mlfakecli` fails `ENOENT` exactly as it
 * does for the real `codex`, which is what arms the fallback under test. (A *full path* to a
 * `.cmd` would fail `EINVAL` instead, since Node refuses those outright post-CVE-2024-27980, and
 * would therefore not exercise this path at all.)
 */
async function withCmdShim(
  body: (ctx: { dir: string; marker: string; run: (args: readonly string[]) => Promise<readonly string[] | null> }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(`${tmpdir()}/osa-exec-test-`);
  const originalPath = process.env["PATH"];
  try {
    const echoArgs = join(dir, "echoargs.js");
    await writeFile(echoArgs, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(join(dir, "mlfakecli.cmd"), `@ECHO off\r\n"${process.execPath}" "${echoArgs}" %*\r\n`);
    process.env["PATH"] = `${dir}${delimiter}${originalPath ?? ""}`;
    await body({
      dir,
      marker: join(dir, "injection-marker.txt"),
      run: async (args) => {
        const result = await runProcess({ command: "mlfakecli", args, cwd: dir, timeoutMs: 30_000 });
        try {
          return JSON.parse(result.stdout.trim()) as readonly string[];
        } catch {
          return null;
        }
      },
    });
  } finally {
    process.env["PATH"] = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
}

test("runProcess resolves (never rejects) on a genuinely nonexistent command", async () => {
  await assert.doesNotReject(async () => {
    await runProcess({
      command: "osa-definitely-not-a-real-binary-xyz",
      args: ["--version"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
  });
});

test(
  "a spawn failure whose argv contains an IRREDUCIBLY unsafe character (`%`) is never relaunched: " +
    "exitCode stays null, per §6.1 step 6 literally. NOTE: this test used to use `a & b`, which the " +
    "fallback's original blanket blocklist also refused; `&` is now correctly *escaped* rather than " +
    "refused, so the refusal contract is pinned here with a character that genuinely cannot be made " +
    "safe (cmd.exe expands `%VAR%` before any quoting this code can emit takes effect).",
  async () => {
    const result = await runProcess({
      command: "osa-definitely-not-a-real-binary-xyz",
      args: ["a %PATH% b"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(result.timedOut, false);
  },
);

// --- Windows cmd.exe relaunch quoting (pure, so these run on every platform) -------------------

test("quoteForWindowsCommandLine: quotes, backslash runs, and the empty string follow the CommandLineToArgvW rules", () => {
  assert.equal(quoteForWindowsCommandLine("plain"), '"plain"');
  assert.equal(quoteForWindowsCommandLine(""), '""');
  assert.equal(quoteForWindowsCommandLine("with space"), '"with space"');
  // An embedded `"` is DOUBLED (`""`), never emitted as `\"` -- cmd.exe does not understand `\"`,
  // and doubling is what keeps cmd's raw quote count even so the token stays inside quoted context.
  assert.equal(quoteForWindowsCommandLine('approval_policy="never"'), '"approval_policy=""never"""');
  assert.ok(!quoteForWindowsCommandLine('a"b').includes('\\"'));
  // Ordinary path backslashes are literal and must NOT be doubled.
  assert.equal(quoteForWindowsCommandLine("C:\\Users\\hp"), '"C:\\Users\\hp"');
  // A run of backslashes before a quote (or the closing quote) is doubled.
  assert.equal(quoteForWindowsCommandLine("trail\\"), '"trail\\\\"');
  assert.equal(quoteForWindowsCommandLine('a\\"b'), '"a\\\\""b"');
});

test("buildWindowsCmdRelaunch: emits a /d /s /v:OFF /c line wrapped in one outer quote pair", () => {
  const built = buildWindowsCmdRelaunch("codex", ["exec", "-c", 'approval_policy="never"']);
  assert.notEqual(built, null);
  assert.deepEqual(built?.slice(0, 4), ["/d", "/s", "/v:OFF", "/c"]);
  const line = built?.[4] ?? "";
  assert.equal(line, '""codex" "exec" "-c" "approval_policy=""never""""');
  // Quote parity must be even, or cmd.exe would fall out of quoted context mid-line.
  assert.equal((line.match(/"/g) ?? []).length % 2, 0);
});

test("buildWindowsCmdRelaunch: still REFUSES (returns null) what genuinely cannot be escaped, and only that", () => {
  // Irreducibly unsafe -- verified empirically to survive/leak through cmd.exe quoting.
  for (const bad of ["a %PATH% b", "a\rb", "a\nb", "a\0b"]) {
    assert.equal(buildWindowsCmdRelaunch("cli", [bad]), null, `expected refusal for ${JSON.stringify(bad)}`);
    assert.equal(buildWindowsCmdRelaunch(`cli${bad}`, []), null, `expected refusal for command ${JSON.stringify(bad)}`);
  }
  // A command token that would break out of its own quoting is refused too.
  assert.equal(buildWindowsCmdRelaunch('cl"i', []), null);
  assert.equal(buildWindowsCmdRelaunch("cli\\", []), null);
  // ...but everything the OLD blanket blocklist refused is now correctly escaped instead. This is
  // the narrowing that makes the Codex adapter's `-c key="value"` args dispatchable at all.
  for (const good of ['q"uote', "a & b", "c | d", "e > f", "g < h", "i ^ j", "(k)", "l!m", "C:\\p\\d", "n\\"]) {
    assert.notEqual(buildWindowsCmdRelaunch("cli", [good]), null, `expected acceptance for ${JSON.stringify(good)}`);
  }
});

test(
  "REGRESSION (the shipped Windows bug): the real codex-cli argv -- which unavoidably contains " +
    "literal `\"` because Codex's own `-c key=\"value\"` override syntax requires it -- is no longer " +
    "refused by the ENOENT relaunch fallback. Before the fix this returned null, which is why every " +
    "real Codex turn failed with ENOENT on Windows while `doctor --providers` still reported it healthy.",
  () => {
    const codexArgv = [
      "exec", "-c", 'approval_policy="never"', "--sandbox", "workspace-write",
      "-c", 'model_reasoning_effort="high"', "--json", "-C", "C:\\Users\\hp\\OSA", "-",
    ];
    assert.notEqual(buildWindowsCmdRelaunch("codex", codexArgv), null);
  },
);

test(
  "SAFETY: an adversarial argument combining `\"` with cmd.exe metacharacters is delivered to the " +
    "target as ONE verbatim argument and executes no extra command -- proven against a real " +
    "`%*`-forwarding .cmd shim, i.e. through cmd.exe's own double parse (the BatBadBut shape)",
  onlyWindows,
  async () => {
    await withCmdShim(async ({ marker, run }) => {
      const adversarial = `foo" & echo INJECTED > "${marker}" & echo "bar`;
      const got = await run([adversarial]);
      // (b) received as a SINGLE argument, byte-for-byte, not split into multiple commands
      assert.deepEqual(got, [adversarial]);
      // (a) the injected `echo ... > marker` never ran
      assert.equal(existsSync(marker), false, "cmd.exe injection: marker file was created");
    });
  },
);

test(
  "SAFETY: a battery of quote/metacharacter shapes all round-trip verbatim through the fallback, " +
    "and none of them creates the injection marker",
  onlyWindows,
  async () => {
    await withCmdShim(async ({ marker, run }) => {
      const cases: readonly (readonly string[])[] = [
        [`" & echo INJECTED > "${marker}" & echo "`],
        [`x" & echo INJECTED > "${marker}" & "y`, 'a"|"b', 'p"^"q', 'r">"s', 'v"<"w'],
        ["a & b", "c | d", "e > f", "g ^ h", "i < j", "(paren)", "bang!bang", "tick`t", "semi;c", "com,ma"],
        ["C:\\path\\dir", 'w\\"q', "trail\\", "d\\\\s", "", "  sp  ", '""', '\\"'],
      ];
      for (const args of cases) {
        assert.deepEqual(await run(args), args, `argv did not round-trip: ${JSON.stringify(args)}`);
      }
      assert.equal(existsSync(marker), false, "cmd.exe injection: marker file was created");
    });
  },
);

test(
  "FUNCTIONAL: the exact codex-cli turn argv (literal `\"` in two `-c` overrides) reaches the " +
    "target through the ENOENT relaunch fallback intact -- the shipped bug's actual failure case",
  onlyWindows,
  async () => {
    await withCmdShim(async ({ run }) => {
      const codexArgv = [
        "exec", "-c", 'approval_policy="never"', "--sandbox", "workspace-write",
        "-c", 'model_reasoning_effort="high"', "--json", "-C", process.cwd(), "-",
      ];
      assert.deepEqual(await run(codexArgv), codexArgv);
    });
  },
);

test(
  "FAIL-SAFE: an argument the fallback cannot safely escape is not silently degraded -- the " +
    "original ENOENT surfaces instead of a mangled or injected command line",
  onlyWindows,
  async () => {
    await withCmdShim(async ({ dir }) => {
      const result = await runProcess({
        command: "mlfakecli",
        args: ["pct-%PATH%-end"],
        cwd: dir,
        timeoutMs: 30_000,
      });
      assert.equal(result.exitCode, null);
      assert.match(result.stderr, /ENOENT/);
      assert.equal(result.stdout, "");
    });
  },
);

test(
  "REGRESSION (flagged in Phase 1 review): a spawn failure for a nonexistent command with " +
    "shell-safe argv does NOT surface as exitCode: null on this platform -- the Windows " +
    "cmd.exe-relaunch fallback resolves cmd.exe's own 'not recognized' result instead, which is " +
    "a real, verified deviation from PHASE_1_SPEC.md §6.1 step 6's literal text. Pinned here so a " +
    "future change to the fallback (or its removal) is a visible, deliberate decision, not a " +
    "silent regression in either direction.",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await runProcess({
      command: "osa-definitely-not-a-real-binary-xyz",
      args: ["--version"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    // What every actual Phase 1 caller relies on (preflight.ts's parse* functions all key on
    // `exitCode !== 0`) continues to hold regardless of which of the two paths above is taken.
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  },
);

test("stdout/stderr are captured and exitCode 0 is reported for a real, trivial subprocess", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('hello'); process.exitCode = 0;"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello");
  assert.equal(result.timedOut, false);
});

test("a nonzero real exit code is reported faithfully, not coerced to null or to a thrown error", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.exitCode = 7;"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
});

test("[DET, FM7] a process that blocks past timeoutMs is killed and resolves with timedOut: true, never success", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60_000);"],
    cwd: process.cwd(),
    timeoutMs: 300,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("[DET, FM7] stdin is closed immediately (never inherited) when no stdin payload is given, so a reading child sees EOF rather than hanging", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [
      "-e",
      "let n = 0; process.stdin.on('data', (c) => { n += c.length; }); " +
        "process.stdin.on('end', () => { process.stdout.write(String(n)); process.exitCode = 0; });",
    ],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    stdin: null,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "0");
  assert.equal(result.timedOut, false);
});

test("a string stdin payload is written to the child and the pipe is closed", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [
      "-e",
      "let buf = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { buf += c; }); " +
        "process.stdin.on('end', () => { process.stdout.write(buf); process.exitCode = 0; });",
    ],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    stdin: "hello from the parent",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello from the parent");
});
