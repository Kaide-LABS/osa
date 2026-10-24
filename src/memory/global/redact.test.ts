// Corpus test for the REDACTING scrubber (docs/osa/memory-phase1/SPEC.md FM-B/FM-C), parallel to
// src/memory/secrets-corpus.test.ts. Where that corpus proves the project store REJECTS a secret-shaped fact, this one
// proves global memory REDACTS the secret-shaped span and keeps the clean remainder -- and that, as the authoritative
// gate, `findSecret` no longer fires on the redacted output. Fake tokens are split across string literals
// (`"ghp_" + "..."`) so GitHub push protection does not block a whole fake token.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, stillHasSecret } from "./redact.ts";
import { findSecret } from "../secrets.ts";

interface Planted {
  readonly name: string;
  /** A sentence with the secret embedded; the clean words around it must survive. */
  readonly sentence: string;
  /** A distinctive clean word that must remain after redaction. */
  readonly keep: string;
}

const CORPUS: readonly Planted[] = [
  { name: "GitHub personal token", sentence: "Cloned the repo using ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 last Tuesday", keep: "Cloned" },
  { name: "AWS access key id", sentence: "Deploy to the bucket used AKIA" + "IOSFODNN7EXAMPLE in prod", keep: "bucket" },
  { name: "Slack bot token", sentence: "The notifier posted via xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx on Fridays", keep: "notifier" },
  { name: "Anthropic key", sentence: "The agent called the API with sk-ant-" + "api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789 for summaries", keep: "summaries" },
  { name: "Stripe live secret key", sentence: "Charges went through sk_live_" + "51H8aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 in checkout", keep: "checkout" },
  { name: "Google API key", sentence: "The maps call used AIzaSy" + "A-aBcDeFgHiJkLmNoPqRsTuVwXyZ01234 on the client", keep: "maps" },
  { name: "JWT", sentence: "The session cookie was eyJhbGci" + "OiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c yesterday", keep: "cookie" },
  { name: "bearer header", sentence: "We sent Authorization: Bearer abcdEFGH1234" + "ijklMNOP5678qrstUVWX to the upstream", keep: "upstream" },
  { name: "password= assignment", sentence: "The staging config had password=hunter2hunter2 committed by mistake", keep: "staging" },
  { name: "api_key: assignment", sentence: "Someone set api_key: Zx9Qw8Er7Ty6 in the yaml", keep: "yaml" },
  { name: "natural-language password", sentence: "The admin account's password is hunter2hunter2 on staging today", keep: "admin" },
  { name: "connection string with password", sentence: "Database is postgres://" + "admin:S3cr3tPass" + "@db.internal:5432/app in the env", keep: "Database" },
];

test("redactor corpus: each secret-shaped span is redacted, the clean remainder survives, and findSecret no longer fires", () => {
  const survived: string[] = [];
  for (const p of CORPUS) {
    const r = redactSecrets(p.sentence);
    assert.ok(r.redactions.length >= 1, `${p.name}: at least one span was redacted`);
    assert.ok(r.text.includes("[redacted:"), `${p.name}: a redaction marker is present`);
    assert.ok(r.text.includes(p.keep), `${p.name}: the clean word "${p.keep}" survived`);
    if (findSecret(r.text) !== null) survived.push(`${p.name} (${findSecret(r.text) ?? ""})`);
  }
  assert.deepEqual(survived, [], "no secret-shaped text may survive redaction");
});

test("FM-C: a secret split over two lines (password: then the value on the next line) is redacted", () => {
  const r = redactSecrets("Note the login details:\npassword:\nhunter2value\nend of note");
  assert.ok(r.redactions.length >= 1);
  assert.equal(stillHasSecret(r.text), false, "findSecret no longer fires");
  assert.ok(r.text.includes("end of note"), "the trailing clean line survives");
});

test("a bare UUID (a run id) is NOT redacted, but a UUID next to a credential word IS", () => {
  const runId = "84ef52b0-6fd5-4f60-8d52-5a7f0b3c1e22";
  const bare = redactSecrets(`Run ${runId} stopped at the build step`);
  assert.deepEqual(bare.redactions, [], "a bare UUID is a run id, left intact");
  assert.ok(bare.text.includes(runId));

  const secret = "4b4b9fd0-8b1d-4c3f-9a9e-1c2d3e4f5a6b";
  const assigned = redactSecrets(`Set HEROKU_API_KEY=${secret} in the dyno`);
  assert.ok(!assigned.text.includes(secret), "a UUID in a credential assignment is redacted");
  assert.equal(stillHasSecret(assigned.text), false);
  assert.ok(assigned.text.includes("dyno"));
});

test("a husk (more than half redacted) is reported via fraction; a clean sentence redacts nothing", () => {
  const husk = redactSecrets("ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
  assert.ok(husk.fraction > 0.5, "an isolated token is almost entirely a secret");
  const clean = redactSecrets("Counts are printed one line per file with a total at the end");
  assert.deepEqual(clean.redactions, []);
  assert.equal(clean.fraction, 0);
  assert.equal(clean.text, "Counts are printed one line per file with a total at the end");
});
