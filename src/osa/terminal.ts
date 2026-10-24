// The real terminal side of the lock: a one-line Lock / Edit / Cancel prompt on stdin/stdout and the
// operator's own editor for "Edit". Kept out of lock.ts so the flow itself is testable with a fake LockIO.
// Also provides the terminal side of the post-spec gate: show TL;DR and ask y/N.

import { createInterface } from "node:readline/promises";
import { runInteractive } from "../util/exec.ts";
import type { LockChoice, LockIO, GateIO } from "./lock.ts";

/** The editor command: `$VISUAL`, else `$EDITOR`, else a platform default. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const configured = env["VISUAL"] ?? env["EDITOR"];
  if (configured !== undefined && configured.trim() !== "") return configured.trim();
  return platform === "win32" ? "notepad" : "vi";
}

/** Maps a typed answer to a {@link LockChoice}; `undefined` for anything unrecognised. Empty input = Lock. */
export function parseLockAnswer(answer: string): LockChoice | undefined {
  const a = answer.trim().toLowerCase();
  if (a === "" || a === "l" || a === "lock" || a === "y" || a === "yes") return "lock";
  if (a === "e" || a === "edit") return "edit";
  if (a === "c" || a === "cancel" || a === "n" || a === "no" || a === "q") return "cancel";
  return undefined;
}

/** Builds the terminal {@link LockIO}. */
export function makeTerminalLockIO(cwd: string): LockIO {
  return {
    show(text: string): void {
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    async choose(): Promise<LockChoice> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const answer = await rl.question("\nLock and run / Edit / Cancel?  [L]ock (default)  [E]dit  [C]ancel: ");
          const choice = parseLockAnswer(answer);
          if (choice !== undefined) return choice;
          process.stdout.write("Please answer L, E or C.\n");
        }
      } finally {
        rl.close();
      }
    },
    async edit(absPath: string): Promise<void> {
      const code = await runInteractive(`${resolveEditorCommand()} "${absPath}"`, cwd);
      if (code === null) {
        process.stdout.write(`Could not start the editor. Edit the file yourself, then press Enter: ${absPath}\n`);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          await rl.question("");
        } finally {
          rl.close();
        }
      }
    },
  };
}

/** Builds the terminal {@link GateIO} for the post-spec gate. */
export function makeTerminalGateIO(): GateIO {
  return {
    show(text: string): void {
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    async confirm(): Promise<boolean> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question("\nApprove and build?  [y]es  [N]o (default): ");
        const trimmed = answer.trim().toLowerCase();
        return trimmed === "y" || trimmed === "yes";
      } finally {
        rl.close();
      }
    },
  };
}

/** The terminal side of the intake nudge for a broad request: show the recommended questions one by one, each with the suggested answer. */
export interface NudgeIO {
  show(text: string): void;
  /** Returns what the person typed; an empty string means "accept the suggested answer". */
  ask(question: string, suggested: string): Promise<string>;
}

/** What the person is told before the questions. Only the measured figure is quoted: the last full spec-only run took about 22 minutes. */
export const NUDGE_TEXT =
  "Your request is broad, so OSA has a few questions. Answering them is highly recommended: research and the spec take about 20 minutes, and a wrong " +
  "direction means paying for that again, plus rewriting your prompt. Press Enter to accept the suggested answer.";

/** Builds the terminal {@link NudgeIO}. */
export function makeTerminalNudgeIO(): NudgeIO {
  return {
    show(text: string): void {
      process.stdout.write(`\n${text}\n`);
    },
    async ask(question: string, suggested: string): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(`\n${question}\n  [Enter = ${suggested}] > `);
      } finally {
        rl.close();
      }
    },
  };
}
