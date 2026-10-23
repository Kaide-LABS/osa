import { test } from "node:test";
import assert from "node:assert/strict";
import { renameWithRetry } from "./store.ts";

const eperm = (): NodeJS.ErrnoException => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

test("renameWithRetry: a rename that fails with EPERM/EBUSY twice and then succeeds is a success (found when two processes updated one index and the second crashed)", async () => {
  let calls = 0;
  const waited: number[] = [];
  await renameWithRetry("a.tmp", "a", {
    rename: () => (++calls <= 2 ? Promise.reject(eperm()) : Promise.resolve()),
    sleep: (ms) => (waited.push(ms), Promise.resolve()),
  });
  assert.equal(calls, 3);
  assert.deepEqual(waited, [25, 50], "short, growing pauses");
});

test("renameWithRetry: gives up after the attempts and throws the last error; any other error is thrown at once", async () => {
  let calls = 0;
  await assert.rejects(renameWithRetry("a.tmp", "a", { attempts: 4, rename: () => (calls++, Promise.reject(eperm())), sleep: () => Promise.resolve() }), /EPERM/);
  assert.equal(calls, 4);
  let other = 0;
  await assert.rejects(renameWithRetry("a.tmp", "a", { rename: () => (other++, Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))), sleep: () => Promise.resolve() }), /ENOENT/);
  assert.equal(other, 1, "a missing file is not retried");
});
