// Downloads the codebase-memory-mcp (CBM) release OSA was evaluated against, and refuses anything else. Lives in the one network-exempt directory
// (boundary rules B3/B4/B9): global `fetch` only, every URL literal here.
//
// The trust model is a PIN, not a lookup: the version and the SHA-256 of every platform's archive are written below (taken from the digests GitHub
// records for the v0.12.1 release; the Windows one was also verified by hand against `checksums.txt` and its sigstore bundle, docs/osa/CBM_NOTES.md section 2).
// A download whose hash is not the pinned one is discarded before anything is written to disk or run. Only github.com and GitHub's release-asset hosts are
// contacted, over https, and a redirect to any other host is refused.

import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FetchFn } from "./http.ts";

export const CBM_VERSION = "0.12.1";

/** One pinned archive. */
export interface CbmAsset {
  readonly name: string;
  readonly sha256: string;
  readonly kind: "zip" | "tar.gz";
  readonly bytes: number;
}

/** Keyed `<node platform>-<node arch>`. Linux uses the portable (statically linked) builds so no particular libc is required. */
export const CBM_ASSETS: Readonly<Record<string, CbmAsset>> = {
  "win32-x64": { name: "codebase-memory-mcp-windows-amd64.zip", sha256: "4e4e0f16b45233af5c757a1fcbe3c3b16e9056375b1fbe2ce020b6de75dedcc0", kind: "zip", bytes: 48_508_123 },
  "win32-arm64": { name: "codebase-memory-mcp-windows-arm64.zip", sha256: "934ab6bd67a76c6ebd9e110d87b7090ffd629919bedaeddabe5a19175038b063", kind: "zip", bytes: 47_934_918 },
  "darwin-x64": { name: "codebase-memory-mcp-darwin-amd64.tar.gz", sha256: "ca6e64397a8ae80cec898a8205a6aa16750ac798acc05a0c3ed983837944a581", kind: "tar.gz", bytes: 50_555_159 },
  "darwin-arm64": { name: "codebase-memory-mcp-darwin-arm64.tar.gz", sha256: "9bfcbe38414b47969a3e1d1c1999f5357409387c86fa3d24221b5458267660d2", kind: "tar.gz", bytes: 49_875_423 },
  "linux-x64": { name: "codebase-memory-mcp-linux-amd64-portable.tar.gz", sha256: "8c3d0341064301e78ecc84cf7348d4e2c6562a0f57448243ea560aaa34de36c1", kind: "tar.gz", bytes: 48_920_994 },
  "linux-arm64": { name: "codebase-memory-mcp-linux-arm64-portable.tar.gz", sha256: "ed0f1f548cd79b121c401c2e9f7841c189a001af26d3768368088c24f6a53533", kind: "tar.gz", bytes: 48_466_763 },
};

/** The pinned asset for this machine, or null when no build exists for it. Pure. */
export function cbmAssetFor(platform: string, arch: string): CbmAsset | null {
  return CBM_ASSETS[`${platform}-${arch}`] ?? null;
}

/** Where `asset` is downloaded from. Pure. */
export function cbmAssetUrl(asset: CbmAsset): string {
  return `https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION}/${asset.name}`;
}

/** The only hosts a download (or a redirect hop) may touch. */
export const CBM_DOWNLOAD_HOSTS: readonly string[] = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
const MAX_REDIRECTS = 4;
/** Hard ceiling on bytes read, whatever the headers say: the pinned archives are about 50 MB. */
const MAX_BYTES = 120_000_000;

/** A modelled failure of the download. */
export class CbmDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CbmDownloadError";
  }
}

/** True iff `url` is https on an allowed host with no credentials and the default port. Pure. */
export function isAllowedDownloadUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.username === "" && u.password === "" && u.port === "" && CBM_DOWNLOAD_HOSTS.includes(u.hostname.toLowerCase());
}

async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > cap) throw new CbmDownloadError(`The download announces ${String(declared)} bytes, more than the ${String(cap)} allowed.`);
  if (res.body === null) throw new CbmDownloadError("The download has no body.");
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new CbmDownloadError(`The download is larger than the ${String(cap)} bytes allowed.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export interface DownloadDeps {
  readonly fetchFn?: FetchFn;
  /** Test seam: lowers the size ceiling. */
  readonly maxBytes?: number;
}

/**
 * Downloads `asset` to `destFile` and verifies its SHA-256 against the pin BEFORE writing: on any problem nothing is left at `destFile`.
 * Returns the verified size.
 */
export async function downloadVerified(asset: CbmAsset, destFile: string, deps: DownloadDeps = {}): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const fetchFn: FetchFn = deps.fetchFn ?? ((u, i) => globalThis.fetch(u, i));
  let url = cbmAssetUrl(asset);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedDownloadUrl(url)) throw new CbmDownloadError(`Refusing to contact ${new URL(url).hostname}: only GitHub's release hosts are allowed, over https.`);
    try {
      res = await fetchFn(url, { redirect: "manual", headers: { accept: "application/octet-stream" } });
    } catch (err) {
      throw new CbmDownloadError(`The download could not be started (${err instanceof Error ? err.message : "request failed"}).`);
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (next === null) throw new CbmDownloadError("The server redirected without saying where.");
      url = new URL(next, url).href;
      continue;
    }
    break;
  }
  if (res === null || (res.status >= 300 && res.status < 400)) throw new CbmDownloadError("Too many redirects.");
  if (res.status !== 200) throw new CbmDownloadError(`The server answered ${String(res.status)}.`);
  const body = await readCapped(res, deps.maxBytes ?? MAX_BYTES);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== asset.sha256) {
    throw new CbmDownloadError(`The downloaded file does not match the pinned checksum (got ${sha256.slice(0, 16)}..., expected ${asset.sha256.slice(0, 16)}...). It was discarded and nothing was installed.`);
  }
  await mkdir(dirname(destFile), { recursive: true });
  const tmp = `${destFile}.${String(process.pid)}.part`;
  await writeFile(tmp, body);
  try {
    await rename(tmp, destFile);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { bytes: body.length, sha256 };
}
