# Semantic code search (`index.engine: "hybrid"`)

OSA's default code index is **lexical**: sub-word TF-IDF, offline, no dependency. It is fast and exact on names, and weak when a question shares
no word with the code ("where do we slow down abusive clients" for `rateLimiter`). The **hybrid** engine adds meaning: the lexical stage proposes
candidate chunks, an **embeddings model re-ranks them**, and the two orders are fused (reciprocal rank fusion). Snippets are still read from the
live file, so a hit can never be older than the file.

It is **off** until you switch it on and give it an embeddings endpoint. Nothing is downloaded and no embeddings call is made otherwise.

## Turning it on

```jsonc
{ "index": { "engine": "hybrid",
             "semantic": { "baseUrl": "https://api.example.com/v1", "model": "your-embedding-model", "apiKeyEnv": "OSA_EMBEDDINGS_API_KEY" } } }
```

or per command: `osa search "..." --index-engine hybrid`. `baseUrl` is any OpenAI-compatible API (`<baseUrl>/embeddings`):

| Option | Key | Notes |
|---|---|---|
| A hosted embeddings API (OpenAI, Voyage, a Gemini or OpenRouter compatibility endpoint) | yes: put it in the environment variable named by `apiKeyEnv`; never in a file | pay-per-token, small: a repository is a few hundred chunks |
| A local server (Ollama, LM Studio, llama.cpp server) | **no** | `baseUrl` on localhost may be plain http; nothing leaves your machine; you pick a model it serves |

Neither Claude Code nor Anthropic's API provides embeddings, and no provider CLI exposes them, which is why OSA asks for an endpoint instead of
reusing the coding tools you already have.

**Verify it before relying on it:** `node scripts/embeddings-smoke.ts` makes a real call and checks that two texts with the same meaning in
different words are closer than an unrelated one (PASS / FAIL). This could not be run in the environment OSA was written in (no endpoint or key
was available), so the engine is tested against a fake embeddings server only; run the smoke test once with your endpoint.

## How it behaves

* **Candidates**: the lexical top `candidateLimit` (default 300) hits, topped up with the rest of the index in path order until that many. A repository
  of up to 300 chunks is searched in full, so a paraphrase with no shared word is still considered. A larger one is searched among the lexical candidates
  only (the answer's reason says which), so semantic recall there is limited by the lexical stage.
* **Cost and cache**: a chunk is embedded once. Vectors are cached in `.osa/index/vectors.jsonl` (derived, gitignored), keyed by a hash of the model and
  the exact text; a query costs one embedding plus any chunk not yet cached. Changing the model re-embeds everything.
* **It cannot make a search fail**: no endpoint set, a 401, a timeout or a malformed answer returns the lexical results, labelled
  `lexical-fallback` with the cause, at confidence "low". `osa doctor` warns when `hybrid` is selected but unconfigured.
* **Safety**: https is required except for localhost; a URL containing credentials, a query or a fragment is refused; redirects are refused; the key
  is read from the named variable and never appears in a log or an error; the response is size-capped and validated; the only host contacted is the
  configured one (boundary rules B3/B4/B9 cover `src/research/net/embeddings.ts`). Code snippets leave your machine only when the endpoint is a hosted one.

## What has and has not been measured

Not measured: whether the hybrid engine beats the lexical one on real queries. The 40-query evaluation in `evals/code-search/` was built over
repository snapshots that are not part of this repository, and embeddings can also rank the wrong function first (an earlier spike with another tool's
embedding path ranked the right function 31st of 50 on a paraphrase). Treat hybrid as an option to try on your own project, compare with
`osa search "..."` under both engines, and keep the default if it does not help.
