import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { defaultOsaConfig } from "../domain/osa-config.ts";
import { InternalError } from "../domain/errors.ts";
import { MinIntervalLimiter } from "../research/net/http.ts";
import { NoopTrimmer } from "../trim/trimmer.ts";
import { MemoryEventSink } from "./events.ts";
import { fakeModel, researchFetch, scriptedTextCall, tempGitRepo } from "./fixtures.test.ts";
import { MAX_PLAIN_CHOICES, buildPlainChoicesPrompt, parsePlainChoices, plainChoices } from "./plain-choices.ts";
import { runOsaCommand } from "./pipeline.ts";

const call = (replies: (string | Error)[]) => scriptedTextCall(replies);
const base = { provider: "claude-code" as const, cwd: "/r", timeoutMs: 1000 };

test("the prompt asks for plain words and forbids programming terms; parsing keeps bullets, strips code ticks, caps the count", () => {
  const p = buildPlainChoicesPrompt(["Uses CommonJS and readFileSync"]);
  assert.match(p, /NOT an engineer/);
  assert.match(p, /no code, no file names, no programming terms/);
  assert.match(p, /- Uses CommonJS and readFileSync/);
  assert.deepEqual(parsePlainChoices("Here you go:\n- It `reads` files whole.\n* Missing files are reported.\nnot a bullet\n-   \n"), ["It reads files whole.", "Missing files are reported."]);
  assert.equal(parsePlainChoices(Array.from({ length: 20 }, (_, i) => `- point ${String(i)}`).join("\n")).length, MAX_PLAIN_CHOICES);
});

test("plainChoices: rewrites via the model; no decisions => no call; a failed or unusable reply => rewritten:false (never raw text)", async () => {
  const ok = call(["- Words are split on spaces.\n- Missing files do not stop the others."]);
  const r = await plainChoices({ ...base, decisions: ["CommonJS", "stdout"], textCall: ok.call });
  assert.deepEqual(r, { bullets: ["Words are split on spaces.", "Missing files do not stop the others."], rewritten: true });
  assert.equal(ok.requests[0]?.purpose, "plain-choices");
  assert.equal(ok.requests[0]?.req.webSearch, false);

  const none = call(["x"]);
  assert.deepEqual(await plainChoices({ ...base, decisions: [], textCall: none.call }), { bullets: [], rewritten: true });
  assert.equal(none.requests.length, 0);

  assert.deepEqual(await plainChoices({ ...base, decisions: ["a"], textCall: call([new InternalError("down")]).call }), { bullets: [], rewritten: false });
  assert.deepEqual(await plainChoices({ ...base, decisions: ["a"], textCall: call(["no bullets here"]).call }), { bullets: [], rewritten: false });
});

const RUN = "abcabcab-cabc-4abc-8abc-abcabcabcabc";
const io = { show: () => undefined, choose: () => Promise.resolve("lock" as const), edit: () => Promise.resolve() };

async function runWith(model: ReturnType<typeof fakeModel>) {
  const repoDir = await tempGitRepo();
  const report = await runOsaCommand(
    { prompt: "make a counter", files: [], repoDir, yes: true, json: false },
    {
      events: new MemoryEventSink(RUN),
      io,
      interactive: true,
      runId: RUN,
      config: defaultOsaConfig(),
      textCall: model.call,
      research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
      trimmer: { trimmer: new NoopTrimmer("noop"), note: null },
      drive: {
        runDispatchFn: (async (rc: { spec_path: string; phase: number; is_final_phase: boolean }) => {
          const dir = rc.spec_path.slice(0, rc.spec_path.lastIndexOf("/") + 1);
          await mkdir(`${repoDir}/${dir}`, { recursive: true });
          await writeFile(rc.is_final_phase ? `${repoDir}/BUILD_COMPLETE.md` : `${repoDir}/${dir}PHASE_${String(rc.phase + 1)}_SPEC.md`, "x\n", "utf8");
          return { ok: true, exitCode: 0, turns: [], halt: null, problems: [], warnings: [] };
        }) as never,
      },
    },
  );
  return { repoDir, report };
}

test("the run summary's 'Choices made for you' is plain language; the raw engineering decisions appear ONLY under 'For engineers'", async () => {
  const { repoDir, report } = await runWith(fakeModel());
  const md = await readFile(`${repoDir}/${report.summary_path as string}`, "utf8");
  const split = md.indexOf("## For engineers (technical detail)");
  assert.ok(split > 0);
  const plain = md.slice(0, split);
  assert.match(plain, /## Choices made for you[\s\S]*- Words are counted by splitting on spaces\.[\s\S]*- A missing file is reported but never stops the other files\./);
  assert.ok(!plain.includes("Output uses plain text."), "the raw spec decision is not in the plain part");
  assert.ok(!plain.includes("Architecture:"), "nor is the raw architecture line");
  assert.match(md.slice(split), /decision: Output uses plain text\./);
  assert.match(md.slice(split), /decision: Architecture: kept the original plan after an independent review/);
});

test("if the plain rewrite is unavailable the summary says how many technical decisions there were -- it does not paste them into the plain part", async () => {
  const { repoDir, report } = await runWith(fakeModel({ failPurposes: new Set(["plain-choices"]) }));
  const md = await readFile(`${repoDir}/${report.summary_path as string}`, "utf8");
  const split = md.indexOf("## For engineers (technical detail)");
  assert.match(md.slice(0, split), /\d+ technical decision\(s\) were made while writing the spec; they are listed under "For engineers"/);
  assert.ok(!md.slice(0, split).includes("Output uses plain text."));
});
