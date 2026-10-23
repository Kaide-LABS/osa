// Suite 8 regression (found by the failed-run summary test): the step-14 note for a stage is shown to a NON-ENGINEER, but its
// deterministic fallback pasted raw problems, warnings and halt text -- including a Windows path and a JSON parse error -- into the plain
// part. And a model-written note was trusted as-is even though the model is fed those same raw facts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicSummary, hasSummaryHeadings, looksTechnical } from "./step14.ts";
import type { PhaseFacts } from "./step14.ts";

const facts = (over: Partial<PhaseFacts> = {}): PhaseFacts => ({
  phase: 1,
  ok: false,
  exitCode: 14,
  turns: [],
  work: [{ role: "executor", provider: "claude-code", workDone: "Built the counter and its tests" }],
  nextSteps: [],
  openQuestions: [],
  haltMessage: "reviewer halted the build",
  changedFiles: [],
  commitSubjects: [],
  problems: [],
  warnings: [],
  ...over,
});

test("looksTechnical recognises paths, file names, hashes, stack traces, JSON errors and exit codes; ordinary prose is fine", () => {
  const technical = [
    "Failed to parse C:/Users/hp/x/000-executor.json: Unexpected token",
    "Failed to parse C:/Users/hp/x.json",
    "see src/osa/pipeline.ts line 40",
    "commit 3f786850e387550fdab836ed7e91f3b9df9c3f1d",
    "Error: ENOENT: no such file or directory",
    "TypeError: x is not a function",
    "process exited with exit code 1",
    "run `npm test`",
    "```js\nconst a = 1;\n```",
    "Unexpected token } in JSON at position 3",
  ];
  for (const t of technical) assert.equal(looksTechnical(t), true, t);
  for (const ok of ["Built the counter and its tests", "reviewer halted the build", "A missing file is reported but never stops the other files.", "Words are counted by splitting on spaces."]) assert.equal(looksTechnical(ok), false, ok);
});

test("the deterministic note keeps raw problems, warnings and technical halt text OUT of the plain part, and says where the detail is", () => {
  const s = deterministicSummary(
    facts({
      haltMessage: "Failed to parse C:/Users/hp/x/000-executor.json: Unexpected token",
      problems: ["Failed to parse C:/Users/hp/x/000-executor.json: Unexpected token", "ENOENT: no such file or directory, open 'a.txt'"],
      warnings: ["chat log is not ignored by git: .osa/chat-log/abc.jsonl"],
      openQuestions: ["Should the tool read stdin when no file is given?"],
      work: [{ role: "executor", provider: "claude-code", workDone: "Edited src/cli/main.ts and test/cli.test.js" }],
    }),
  );
  assert.equal(hasSummaryHeadings(s), true);
  assert.equal(looksTechnical(s), false, s);
  assert.match(s, /did NOT finish/);
  assert.match(s, /technical problem\(s\) were recorded[\s\S]*For engineers/);
  assert.match(s, /Open question: Should the tool read stdin when no file is given\?/, "a plain open question is kept");
  assert.match(s, /did not record what they built|The agents/, "technical 'work done' text is replaced by a neutral line");
});

test("plain halt reasons and plain work descriptions are kept verbatim", () => {
  const s = deterministicSummary(facts());
  assert.match(s, /did NOT finish: reviewer halted the build/);
  assert.match(s, /Built the counter and its tests/);
});
