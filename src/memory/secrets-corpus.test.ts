// Suite 8 -- planted fake secrets in many formats, through the same entry the memory store uses (rejectReason). All values are FAKE
// (documentation examples or random). The test has two jobs: (1) MUST_CATCH formats must be rejected -- these are the formats real
// run output realistically contains; (2) it prints, for the report, exactly which formats the heuristic filter does and does not catch.
// A UUID-shaped secret is its own case (addendum 5): the filter exempts canonical UUIDs because run ids look like them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { appendFacts, rejectReason } from "./store.ts";
import { findSecret } from "./secrets.ts";

interface Planted {
  readonly name: string;
  readonly fact: string;
  /** true = real output realistically contains this, so the filter must catch it. */
  readonly mustCatch: boolean;
}

const UUID_SECRET = "4b4b9fd0-8b1d-4c3f-9a9e-1c2d3e4f5a6b";
const RUN_ID = "84ef52b0-6fd5-4f60-8d52-5a7f0b3c1e22";

const CORPUS: readonly Planted[] = [
  { name: "AWS access key id", fact: "Deploy used AKIA" + "IOSFODNN7EXAMPLE for the bucket", mustCatch: true },
  { name: "AWS secret access key (bare, 40 chars with /)", fact: "The secret was wJalrXUt" + "nFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY for that account", mustCatch: true },
  { name: "GitHub personal token (ghp_" + ")", fact: "Cloned using ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", mustCatch: true },
  { name: "GitHub fine-grained token", fact: "Pushed with github_pat_" + "11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789abcdefghijklmnopqrstuv", mustCatch: true },
  { name: "Slack bot token", fact: "Posted via xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx", mustCatch: true },
  { name: "Stripe live secret key (underscore form)", fact: "Charged with sk_live_" + "51H8aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", mustCatch: true },
  { name: "Stripe restricted key (rk_live_" + ")", fact: "Webhook used rk_live_" + "aBcDeFgHiJkLmNoPqRsTuVwX", mustCatch: true },
  { name: "OpenAI key (sk-proj-" + ")", fact: "Called the API with sk-proj-" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345", mustCatch: true },
  { name: "Anthropic key", fact: "Used sk-ant-" + "api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789", mustCatch: true },
  { name: "Google API key", fact: "Maps call used AIzaSy" + "A-aBcDeFgHiJkLmNoPqRsTuVwXyZ01234", mustCatch: true },
  { name: "JWT", fact: "Session was eyJhbGci" + "OiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", mustCatch: true },
  { name: "Bearer header", fact: "Sent Authorization: Bearer abcdEFGH1234" + "ijklMNOP5678qrstUVWX", mustCatch: true },
  { name: "password= assignment", fact: "Config had password=hunter2hunter2", mustCatch: true },
  { name: "api_key: assignment", fact: "Set api_key: Zx9Qw8Er7Ty6", mustCatch: true },
  { name: "connection string with password", fact: "Database is postgres://" + "admin:S3cr3tPass" + "@db.internal:5432/app", mustCatch: true },
  { name: "private key header", fact: "File began -----BEGIN RSA PRIVATE KEY" + "-----", mustCatch: true },
  { name: "npm token", fact: "Published with npm_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", mustCatch: true },
  { name: "SendGrid key", fact: "Mail via SG." + "aBcDeFgHiJkLmNoPqRsTuV.aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJk", mustCatch: true },
  { name: "Telegram bot token", fact: "Bot token 110201543:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw was used", mustCatch: true },
  { name: "Discord bot token", fact: "Discord login with MTk4NjIy" + "NDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKWs", mustCatch: true },
  { name: "natural-language password", fact: "The admin account's password is hunter2hunter2 on staging", mustCatch: true },
  { name: "HTTP Basic auth header", fact: "Sent Authorization: Basic dXNlcjpwYXNz" + "d29yZDEyMzQ1Njc4OTA=", mustCatch: true },
  { name: "UUID-shaped secret with an assignment word", fact: `Set HEROKU_API_KEY=${UUID_SECRET}`, mustCatch: true },
  { name: "UUID-shaped secret in a sentence (no '=' or ':')", fact: `Use the key ${UUID_SECRET} for the vendor API`, mustCatch: true },
  { name: "UUID-shaped secret after the word 'token'", fact: `The service token ${UUID_SECRET} rotates monthly`, mustCatch: true },
  { name: "Azure storage account key (88-char base64)", fact: "Storage used Eby8vdM" + "02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==", mustCatch: true },
  { name: "40-char hex secret next to the word secret", fact: "The webhook secret 9f86d081" + "884c7d659a2feaa0c55ad015a3bf4f1b is stored", mustCatch: true },
  // -- must NOT be rejected: ordinary identifiers and prose that merely resemble secrets
  { name: "a run id (bare UUID)", fact: `Run ${RUN_ID} stopped at the build step`, mustCatch: false },
  { name: "the words secret/token with no value", fact: "The tool never prints the token or the secret it was given", mustCatch: false },
  { name: "a file path and a version", fact: "Node 24 is required; src/cli/main.ts is the entry point", mustCatch: false },
  { name: "a plain decision", fact: "Counts are printed one line per file with a total at the end", mustCatch: false },
];

test("planted-secret corpus: every format that real output contains is rejected; ordinary identifiers and prose are not", () => {
  const caught: string[] = [];
  const missed: string[] = [];
  const falsePositives: string[] = [];
  for (const p of CORPUS) {
    const reason = rejectReason(p.fact);
    if (p.mustCatch) (reason === null ? missed : caught).push(p.name);
    else if (reason !== null) falsePositives.push(`${p.name} (${reason})`);
  }
  process.stdout.write(`\n[secrets-corpus] caught ${String(caught.length)} of ${String(caught.length + missed.length)} planted formats\n[secrets-corpus] MISSED: ${missed.length === 0 ? "(none)" : missed.join(" | ")}\n[secrets-corpus] false positives: ${falsePositives.length === 0 ? "(none)" : falsePositives.join(" | ")}\n`);
  assert.deepEqual(falsePositives, [], "ordinary identifiers and prose must not be rejected");
  assert.deepEqual(missed, [], `formats that reached memory: ${missed.join(", ")}`);
});

test("through the store: a planted secret never reaches the memory file on disk; the clean fact next to it does", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-mem-`);
  const facts = [`Use the key ${UUID_SECRET} for the vendor API`, "Counts are printed one line per file", "Deploy used AKIA" + "IOSFODNN7EXAMPLE for the bucket", `Run ${RUN_ID} stopped at the build step`];
  const r = await appendFacts(dir, "decisions", facts, { maxFacts: 50 });
  assert.equal(r.rejected.length, 2);
  assert.ok(r.rejected.every((x) => /looks like it contains/.test(x.reason)));
  const onDisk = await readFile(`${dir}/.osa/memory/decisions.md`, "utf8");
  assert.ok(!onDisk.includes(UUID_SECRET) && !onDisk.includes("AKIA" + "IOSFODNN7EXAMPLE"), "neither secret is in the file");
  assert.match(onDisk, /Counts are printed one line per file/);
  assert.ok(onDisk.includes(RUN_ID), "the run id (a bare UUID) is kept");
});

test("a bare UUID is still exempt (run ids are not secrets) while a UUID beside a credential word is not", () => {
  assert.equal(findSecret(`failed for run ${RUN_ID}`), null);
  assert.equal(findSecret(`record id ${RUN_ID} was written`), null);
  assert.notEqual(findSecret(`secret ${UUID_SECRET}`), null);
  assert.notEqual(findSecret(`API key: ${UUID_SECRET}`), null);
  assert.notEqual(findSecret(`${UUID_SECRET} is the password`), null);
});

test("DOCUMENTED LIMITS: obfuscated secrets are NOT caught by a pattern filter (this test pins the gap so it stays visible in the report)", () => {
  const evaded: [string, string][] = [
    ["spaced-out characters", "Deploy used A K I A I O S F O D N N 7 E X A M P L E for the bucket"],
    ["base64 of a credential assignment", `Config blob ${Buffer.from("password=hunter2hunter2").toString("base64")}`],
    ["zero-width characters inside the key", "Deploy used AKIA" + "​IOSFODNN7EXAMPLE for the bucket"],
    ["a secret split across two facts (first half)", "The key starts with ghp_" + "aBcDeFgHiJkL and continues in the next note"],
  ];
  const caught = evaded.filter(([, fact]) => rejectReason(fact) !== null).map(([n]) => n);
  process.stdout.write(`[secrets-corpus] documented limits -- obfuscations that still evade the filter: ${evaded.map(([n]) => n).filter((n) => !caught.includes(n)).join(" | ")}\n`);
  assert.ok(evaded.length - caught.length >= 3, "if the filter learns to catch these, update the report's limits section and this test");
});
