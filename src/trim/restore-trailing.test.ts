// Regression (found by the Suite 1 live test with the real trim-1 binary): an input ending in a newline produced a phantom
// trailing "… 1 lines …" marker and a removedLines count one too high, because the empty string after the final "\n" was treated as a
// real input line that the engine had dropped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Trim1Trimmer, restoreProtectedLines } from "./trim1.ts";
import type { RawInvocationResult } from "../domain/run.ts";

const input = ["# Title", "alpha", "beta", "ERROR: boom", "gamma", "delta", ""].join("\n"); // ends with a newline

test("restoreProtectedLines: an input that ends with a newline gets no phantom trailing marker, and removedLines counts real lines only", () => {
  // the engine kept the title and gamma, dropped alpha, beta, the ERROR line and delta
  const engine = ["# Title", "… 3 lines …", "gamma", "… 1 lines …"].join("\n");
  const r = restoreProtectedLines(input, engine, []);
  assert.equal(r.output, ["# Title", "… 2 lines …", "ERROR: boom", "gamma", "… 1 lines …"].join("\n"));
  assert.equal(r.removedLines, 3);
  // with and without the trailing newline the result is the same
  const noNl = restoreProtectedLines(input.replace(/\n$/, ""), engine, []);
  assert.equal(noNl.output, r.output);
  assert.equal(noNl.removedLines, r.removedLines);
});

test("Trim1Trimmer keeps a single trailing newline on the output and never appends a phantom marker line", async () => {
  const body = Array.from({ length: 60 }, (_, i) => `line ${String(i)} of ordinary prose about nothing in particular`).concat(["tail"]).join("\n") + "\n";
  const fake = (): Promise<RawInvocationResult> =>
    Promise.resolve({ exitCode: 0, signal: null, stdout: ["line 0 of ordinary prose about nothing in particular", "… 59 lines …", "tail"].join("\n") + "\n", stderr: "trim: kept 2 lines, removed 59, 1 -> 1 bytes\n", durationMs: 1, timedOut: false });
  const r = await new Trim1Trimmer({ command: "trim", point: "balanced", runProcessFn: fake }).trim(body, { budgetTokens: 1, keep: [], query: "tail" });
  assert.equal(r.applied, true);
  assert.equal(r.output, ["line 0 of ordinary prose about nothing in particular", "… 59 lines …", "tail"].join("\n") + "\n");
  assert.equal(r.removedLines, 59);
});
