// The embeddings client: turns texts into vectors through an OpenAI-compatible `/embeddings` endpoint the OPERATOR configured
// (`index.semantic.baseUrl`): OpenAI, Voyage, a Gemini or OpenRouter compatibility endpoint, or a local server such as Ollama or LM Studio
// (no key at all). It is part of the one network-exempt directory (boundary rules B3/B4/B9): global `fetch` only, no URL literals, and it talks
// to exactly one host, the one in the config. Nothing here is reachable unless `index.engine` is "hybrid".
//
// Safety, on top of the boundary rules: https is required except for a loopback address; a URL with credentials, a query or a fragment is
// refused; redirects are refused (an endpoint that redirects is not the endpoint that was configured); the API key is read from the
// environment variable NAMED in the config and is never logged or put in an error message; the response is size-capped and validated.

import type { FetchFn } from "./http.ts";

export interface EmbeddingsConfig {
  /** Base URL of an OpenAI-compatible API; `/embeddings` is appended. */
  readonly baseUrl: string;
  readonly model: string;
  /** NAME of the environment variable holding the API key; empty, or the variable unset, sends no Authorization header (a local server). */
  readonly apiKeyEnv: string;
  readonly timeoutMs: number;
  /** Texts per request. */
  readonly batchSize: number;
}

export interface EmbeddingsDeps {
  readonly fetchFn?: FetchFn;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** A modelled failure of the embeddings call. The message never contains the key. */
export class EmbeddingsError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "EmbeddingsError";
    this.status = status;
  }
}

const MAX_RESPONSE_CHARS = 64_000_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The validated endpoint URL (`<base>/embeddings`), or an {@link EmbeddingsError} saying what is wrong with the configured base URL. Pure. */
export function embeddingsEndpoint(baseUrl: string): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new EmbeddingsError("index.semantic.baseUrl is not a valid URL.");
  }
  const loopback = LOOPBACK.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new EmbeddingsError("index.semantic.baseUrl must be https (plain http is accepted only for localhost).");
  }
  if (u.username !== "" || u.password !== "") throw new EmbeddingsError("index.semantic.baseUrl must not contain credentials; put the key in an environment variable and name it in index.semantic.apiKeyEnv.");
  if (u.search !== "" || u.hash !== "") throw new EmbeddingsError("index.semantic.baseUrl must not contain a query or a fragment.");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}/embeddings`;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/** Embeds `texts`, in order, one vector each (all of the same length). Throws {@link EmbeddingsError}; never returns a partial result. */
export async function embedTexts(cfg: EmbeddingsConfig, texts: readonly string[], deps: EmbeddingsDeps = {}): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const endpoint = embeddingsEndpoint(cfg.baseUrl);
  if (cfg.model === "") throw new EmbeddingsError("index.semantic.model is not set.");
  const fetchFn: FetchFn = deps.fetchFn ?? ((u, i) => globalThis.fetch(u, i));
  const env = deps.env ?? process.env;
  const key = cfg.apiKeyEnv === "" ? undefined : env[cfg.apiKeyEnv];
  const out: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += cfg.batchSize) {
    const batch = texts.slice(start, start + cfg.batchSize);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let text: string;
    let status: number;
    try {
      const res = await fetchFn(endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", ...(key !== undefined && key !== "" ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: cfg.model, input: batch }),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const reason = controller.signal.aborted ? `no answer within ${String(cfg.timeoutMs)} ms` : err instanceof Error ? err.message.replace(key ?? "\u0000", "[key]") : "request failed";
      throw new EmbeddingsError(`The embeddings endpoint could not be reached (${reason}).`);
    } finally {
      clearTimeout(timer);
    }
    if (status < 200 || status >= 300) {
      throw new EmbeddingsError(`The embeddings endpoint answered ${String(status)}${status === 401 || status === 403 ? ` (check the key in the environment variable ${cfg.apiKeyEnv === "" ? "(none is named)" : cfg.apiKeyEnv})` : ""}.`, status);
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new EmbeddingsError("The embeddings response is too large.");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new EmbeddingsError("The embeddings endpoint did not answer with JSON.");
    }
    const data = typeof json === "object" && json !== null ? (json as Record<string, unknown>)["data"] : undefined;
    if (!Array.isArray(data) || data.length !== batch.length) throw new EmbeddingsError("The embeddings response does not hold one vector per text.");
    const ordered = [...data].sort((a, b) => Number((a as { index?: number }).index ?? 0) - Number((b as { index?: number }).index ?? 0));
    for (const item of ordered) {
      const e = typeof item === "object" && item !== null ? (item as Record<string, unknown>)["embedding"] : undefined;
      if (!isNumberArray(e)) throw new EmbeddingsError("The embeddings response holds a vector that is empty or not numbers.");
      out.push(Float32Array.from(e));
    }
  }
  const dim = (out[0] as Float32Array).length;
  if (out.some((v) => v.length !== dim)) throw new EmbeddingsError("The embeddings response mixes vector sizes.");
  return out;
}

/** Cosine similarity of two equal-length vectors; 0 when either has no length. Pure. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}
