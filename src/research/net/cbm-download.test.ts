import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { CBM_ASSETS, CBM_VERSION, CbmDownloadError, cbmAssetFor, cbmAssetUrl, downloadVerified, isAllowedDownloadUrl } from "./cbm-download.ts";
import type { CbmAsset } from "./cbm-download.ts";
import type { FetchFn } from "./http.ts";

const bytes = Buffer.from("pretend this is a program archive");
const asset: CbmAsset = { name: "fake-asset.zip", sha256: createHash("sha256").update(bytes).digest("hex"), kind: "zip", bytes: bytes.length };
const ok = (body: Buffer = bytes): Response => new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
const redirect = (to: string): Response => new Response(null, { status: 302, headers: { location: to } });

test("the pin: every supported platform has a SHA-256, an archive name for the pinned version's release and a URL on github.com; the Windows value is the one verified by hand", () => {
  assert.equal(CBM_VERSION, "0.12.1");
  assert.deepEqual(Object.keys(CBM_ASSETS).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
  for (const [key, a] of Object.entries(CBM_ASSETS)) {
    assert.match(a.sha256, /^[0-9a-f]{64}$/, key);
    assert.ok(a.bytes > 40_000_000 && a.bytes < 60_000_000, key);
    assert.equal(a.kind, a.name.endsWith(".zip") ? "zip" : "tar.gz");
    assert.ok(isAllowedDownloadUrl(cbmAssetUrl(a)), key);
    assert.match(cbmAssetUrl(a), new RegExp(`^https://github\\.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION.replaceAll(".", "\\.")}/`));
  }
  assert.equal(CBM_ASSETS["win32-x64"]?.sha256, "4e4e0f16b45233af5c757a1fcbe3c3b16e9056375b1fbe2ce020b6de75dedcc0");
  assert.equal(cbmAssetFor("win32", "x64"), CBM_ASSETS["win32-x64"]);
  assert.equal(cbmAssetFor("freebsd", "x64"), null);
  assert.equal(cbmAssetFor("linux", "ia32"), null);
});

test("isAllowedDownloadUrl: https on GitHub's release hosts only; no credentials, no odd port, no other host, no http", () => {
  for (const good of ["https://github.com/a/b/releases/download/v1/x.zip", "https://release-assets.githubusercontent.com/x?sig=1", "https://objects.githubusercontent.com/x"]) assert.equal(isAllowedDownloadUrl(good), true, good);
  for (const bad of ["http://github.com/x", "https://evil.example.org/x", "https://github.com.evil.example.org/x", "https://user:pw@github.com/x", "https://github.com:8443/x", "https://raw.githubusercontent.com/x", "ftp://github.com/x", "not a url"]) assert.equal(isAllowedDownloadUrl(bad), false, bad);
});

test("downloadVerified: follows GitHub's redirect to the asset host, verifies the hash, and only then writes the file", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-dl-`);
  const seen: string[] = [];
  const fetchFn: FetchFn = (url, init) => {
    seen.push(url);
    assert.equal(init?.redirect, "manual", "redirects are followed by hand so each hop can be checked");
    return Promise.resolve(url.startsWith("https://github.com/") ? redirect("https://release-assets.githubusercontent.com/abc?sig=1") : ok());
  };
  const got = await downloadVerified(asset, `${dir}/out/${asset.name}`, { fetchFn });
  assert.equal(got.sha256, asset.sha256);
  assert.equal(got.bytes, bytes.length);
  assert.deepEqual(await readFile(`${dir}/out/${asset.name}`), bytes);
  assert.equal(seen.length, 2);
  assert.deepEqual(await readdir(`${dir}/out`), [asset.name], "no temporary file is left behind");
});

test("downloadVerified: a file with the wrong hash is discarded and NOTHING is written", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-dl-`);
  const tampered = Buffer.from("an archive somebody swapped");
  await assert.rejects(downloadVerified(asset, `${dir}/out/${asset.name}`, { fetchFn: () => Promise.resolve(ok(tampered)) }), (e: unknown) => e instanceof CbmDownloadError && /does not match the pinned checksum/.test(e.message) && /nothing was installed/.test(e.message));
  await assert.rejects(readdir(`${dir}/out`), "not even the directory is created");
});

test("downloadVerified: a redirect to any other host is refused before it is contacted", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-dl-`);
  const contacted: string[] = [];
  const fetchFn: FetchFn = (url) => {
    contacted.push(url);
    return Promise.resolve(redirect("https://evil.example.org/payload.zip"));
  };
  await assert.rejects(downloadVerified(asset, `${dir}/x`, { fetchFn }), /Refusing to contact evil\.example\.org/);
  assert.equal(contacted.length, 1, "only GitHub was ever contacted");
  await assert.rejects(downloadVerified(asset, `${dir}/x`, { fetchFn: () => Promise.resolve(redirect("http://github.com/insecure")) }), /Refusing to contact/);
});

test("downloadVerified: redirect loops, missing Location, HTTP errors, and oversized bodies (announced or not) are all refused", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-dl-`);
  const run = (fetchFn: FetchFn, maxBytes?: number) => downloadVerified(asset, `${dir}/x`, { fetchFn, ...(maxBytes !== undefined ? { maxBytes } : {}) });
  await assert.rejects(run(() => Promise.resolve(redirect("https://github.com/again"))), /Too many redirects/);
  await assert.rejects(run(() => Promise.resolve(new Response(null, { status: 302 }))), /without saying where/);
  await assert.rejects(run(() => Promise.resolve(new Response("nope", { status: 404 }))), /answered 404/);
  await assert.rejects(run(() => Promise.resolve(ok()), 10), /announces|larger than/);
  const unannounced = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); c.enqueue(new Uint8Array(100)); c.close(); } }), { status: 200 });
  await assert.rejects(run(() => Promise.resolve(unannounced), 150), /larger than the 150 bytes allowed/);
  await assert.rejects(run(() => Promise.reject(new Error("getaddrinfo ENOTFOUND github.com"))), /could not be started/);
});
