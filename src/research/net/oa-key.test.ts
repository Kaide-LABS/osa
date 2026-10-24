import assert from "node:assert/strict";
import { test } from "node:test";
import { searchOpenAlex } from "./openalex.ts";
import type { FetchFn } from "./http.ts";

const work = { results: [{ id: "https://openalex.org/W1", title: "A paper" }] };

test("OpenAlex: a key it rejects (not activated, mistyped) falls back to the keyless budget, still returns the records, and says so", async () => {
  const urls: string[] = [];
  const fetchFn: FetchFn = (url) => {
    urls.push(url);
    return Promise.resolve(
      new URL(url).searchParams.has("api_key")
        ? new Response(JSON.stringify({ error: "Forbidden", code: "key_not_activated" }), { status: 403 })
        : new Response(JSON.stringify(work), { status: 200 }),
    );
  };
  const r = await searchOpenAlex("token bucket", { apiKey: "K" }, { fetchFn, sleepFn: () => Promise.resolve() });
  assert.equal(r.records.length, 1, "the search still worked");
  assert.match(r.problem ?? "", /rejected the API key.*activat.*keyless budget/);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[0] as string).searchParams.get("api_key"), "K");
  assert.equal(new URL(urls[1] as string).searchParams.has("api_key"), false, "the retry carries no key");
});

test("OpenAlex: a working key is used once and raises no note; a keyless 403 is not retried; if the keyless retry fails too both facts are reported", async () => {
  let calls = 0;
  const ok: FetchFn = () => (calls++, Promise.resolve(new Response(JSON.stringify(work), { status: 200 })));
  const good = await searchOpenAlex("x", { apiKey: "K" }, { fetchFn: ok, sleepFn: () => Promise.resolve() });
  assert.deepEqual([calls, good.problem], [1, null]);
  calls = 0;
  const forbidden: FetchFn = () => (calls++, Promise.resolve(new Response("no", { status: 403 })));
  const keyless = await searchOpenAlex("x", {}, { fetchFn: forbidden, sleepFn: () => Promise.resolve() });
  assert.equal(calls, 1, "no key was sent, so nothing to fall back from");
  assert.deepEqual(keyless.records, []);
  calls = 0;
  const bothFail = await searchOpenAlex("x", { apiKey: "K" }, { fetchFn: forbidden, sleepFn: () => Promise.resolve() });
  assert.equal(calls, 2);
  assert.match(bothFail.problem ?? "", /rejected the API key.*; .*403/);
});
