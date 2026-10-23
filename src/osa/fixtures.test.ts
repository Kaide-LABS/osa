// Shared fixtures for OSA pipeline tests. Named *.test.ts so the boundary scan and the publish build exclude it;
// it contains only data builders (the runner reports it as an empty, passing file).

import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { BabyPrd } from "../domain/intake.ts";
import { StageError } from "../domain/errors.ts";
import type { ProviderId } from "../domain/run.ts";
import type { TextCall, TextCallResult, TextRequest } from "../ports/text-provider.ts";
import type { FetchFn } from "../research/net/http.ts";

/** A valid PRD with one safe and (optionally) one risky assumption. */
export function samplePrd(opts: { risky?: boolean } = {}): BabyPrd {
  return {
    tldr: ["A small command-line tool that counts words in text files.", "You run it on a file and it prints the count.", "You will know it works when the counts match a manual count."],
    problem: "People want a quick word count without opening an editor.",
    users: "Writers and students working in a terminal.",
    inScope: ["Count words in one or more files", "Print a total"],
    outOfScope: ["A graphical interface"],
    acceptanceCriteria: ["Running the tool on a file with 5 words prints 5.", "A missing file prints a clear error and exits non-zero."],
    constraints: ["Node.js only", "No network access"],
    researchPlan: {
      topic: "Word counting CLI",
      timeRange: "last 3 years",
      items: [
        { slug: "node-cli-conventions", title: "Node CLI conventions", question: "How should a Node CLI parse arguments and exit?", modules: ["general-web"] },
        { slug: "tokenization-prior-art", title: "Tokenisation prior art", question: "How do existing tools define a word?", modules: ["general-web", "academic-papers"] },
      ],
      docsTargets: ["Node.js"],
      academicQueries: ["word segmentation algorithms"],
      priorArtQueries: ["word count cli node"],
    },
    assumptions: [
      { text: "Words are separated by whitespace.", risk: "safe" },
      ...(opts.risky === true ? [{ text: "Input files may contain personal data and are never uploaded.", risk: "risky" as const }] : []),
    ],
  };
}

/** A fake {@link TextCall} replying with the scripted texts in order (last one repeats). Records requests. */
export function scriptedTextCall(replies: readonly (string | Error)[]): { call: TextCall; requests: { provider: ProviderId; req: TextRequest; purpose: string }[] } {
  const requests: { provider: ProviderId; req: TextRequest; purpose: string }[] = [];
  let i = 0;
  const call: TextCall = (provider, req, purpose) => {
    requests.push({ provider, req, purpose });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    const result: TextCallResult =
      typeof reply === "string"
        ? { provider, outcome: { ok: true, text: reply, failure: null }, durationMs: 1 }
        : { provider, outcome: { ok: false, text: null, failure: reply as never }, durationMs: 1 };
    return Promise.resolve(result);
  };
  return { call, requests };
}

/** A fresh temp git repo with one commit. */
export async function tempGitRepo(prefix = "osa-test-"): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/${prefix}`);
  const run = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  run("init", "-q");
  run("config", "user.email", "osa-test@example.com");
  run("config", "user.name", "osa-test");
  run("config", "commit.gpgsign", "false");
  await writeFile(`${dir}/README.md`, "# fixture\n", "utf8");
  run("add", "-A");
  run("commit", "-q", "-m", "initial");
  return dir;
}

// ---- shared fakes for research / spec / pipeline tests ----

export const FAKE_SPEC_REPLY = [
  "=== TOTAL_PHASES ===",
  "2",
  "=== SPEC_ASSUMPTIONS ===",
  "- Output uses plain text.",
  "- Nothing from the unconfirmed claims was relied on.",
  "=== CONTEXT.MD ===",
  "# Context",
  "Node CLI. Phase 1 builds the counter; phase 2 adds multiple files.",
  "=== PHASE_1_SPEC.MD ===",
  "# Phase 1",
  "Build the counter.",
  "",
  "## Part A (first agent)",
  "Implement countWords and the CLI entry point.",
  "",
  "## Part B (second agent)",
  "Add edge-case tests, error handling for missing files, and the README.",
  "",
  "## Documentation sources",
  "- https://example.org/docs-node-js",
].join("\n");

const ARXIV = `<feed><entry><id>http://arxiv.org/abs/2001.00001v1</id><title>Word segmentation algorithms for text</title>
<summary>We study word segmentation algorithms and tokenisation of text.</summary><published>2020-01-01T00:00:00Z</published>
<link href="https://arxiv.org/pdf/2001.00001v1" title="pdf"/><author><name>A. Author</name></author></entry></feed>`;
const OPENALEX = JSON.stringify({
  results: [{ id: "https://openalex.org/W9", doi: "https://doi.org/10.5/seg", title: "Word segmentation algorithms for text", publication_year: 2021, cited_by_count: 12, abstract_inverted_index: { Word: [0], segmentation: [1], algorithms: [2], for: [3], text: [4] } }],
});
const GITHUB_SEARCH = JSON.stringify({ items: [{ full_name: "o/wc", html_url: "https://github.com/o/wc", description: "word count", stargazers_count: 50, language: "JavaScript", updated_at: "2026-01-01T00:00:00Z", license: { spdx_id: "MIT" } }] });

export const researchFetch: FetchFn = (url) => {
  const u = new URL(url);
  if (u.hostname === "export.arxiv.org") return Promise.resolve(new Response(ARXIV));
  if (u.hostname === "api.openalex.org") return Promise.resolve(new Response(OPENALEX));
  if (u.pathname.endsWith("/readme")) return Promise.resolve(new Response("# wc\nCounts words."));
  if (u.pathname.endsWith("/contents/")) return Promise.resolve(new Response(JSON.stringify([{ name: "package.json" }, { name: "src" }])));
  if (u.pathname.endsWith("/contents/package.json")) return Promise.resolve(new Response('{"name":"wc"}'));
  if (u.hostname === "api.github.com") return Promise.resolve(new Response(GITHUB_SEARCH));
  return Promise.resolve(new Response("", { status: 404 }));
};

export interface Recorded {
  provider: ProviderId;
  purpose: string;
  req: TextRequest;
}

export function fakeModel(opts: { docsType?: "official-docs" | "article"; crosscheck?: unknown; failPurposes?: Set<string>; prd?: BabyPrd; spec?: string; lateral?: unknown; decision?: string; implication?: unknown; application?: "pass" | "unmet" | "no-evidence" | "missing" } = {}): { call: TextCall; log: Recorded[] } {
  const log: Recorded[] = [];
  const call: TextCall = (provider, req, purpose) => {
    log.push({ provider, purpose, req });
    const ok = (text: string) => Promise.resolve({ provider, outcome: { ok: true as const, text, failure: null }, durationMs: 1 });
    if (opts.failPurposes?.has(purpose)) {
      return Promise.resolve({ provider, outcome: { ok: false as const, text: null, failure: new StageError("provider down") }, durationMs: 1 });
    }
    if (purpose.startsWith("research:")) {
      const slug = purpose.slice("research:".length);
      const isDocs = slug.startsWith("docs-");
      return ok(
        JSON.stringify({
          summary: `Findings for ${slug}.`,
          key_findings: ["a finding"],
          recommendations: ["a recommendation"],
          as_of: "2026-10-01",
          sources: [{ title: "Source", url: `https://example.org/${slug}`, type: isDocs ? (opts.docsType ?? "official-docs") : "article", quote: "q" }],
          uncertain: [],
          ...(isDocs ? { current_version: "1.0", api_surface: ["fn"], pitfalls: ["none"] } : {}),
        }),
      );
    }
    if (purpose === "intake") return ok(JSON.stringify(opts.prd ?? samplePrd()));
    if (purpose === "spec") return ok(opts.spec ?? FAKE_SPEC_REPLY);
    if (purpose === "lateral-architecture") {
      return ok(JSON.stringify(opts.lateral ?? { alternatives: [{ name: "Streaming pipeline", summary: "Process files as streams.", howItDiffers: "Streams data instead of reading whole files.", pros: ["low memory"], cons: ["more code"], betterWhen: "files are huge" }], leaning: "keep-planned", note: "" }));
    }
    if (purpose === "architecture-decision") {
      return ok(opts.decision ?? ["=== ARCHITECTURE_DECISION ===", "Chosen: planned", "Why: Files are small, so reading whole files is simpler and meets the criteria."].join("\n"));
    }
    if (purpose === "implication") {
      return ok(JSON.stringify(opts.implication ?? { consequences: [{ area: "user-impact", consequence: "A missing file could abort the whole run.", material: true, action: "acceptance-criterion", text: "A missing file prints an error and the remaining files are still counted." }, { area: "maintenance", consequence: "Tests need fixtures.", material: false, action: "note", text: "Fixtures are created in a temp directory." }] }));
    }
    if (purpose === "application") {
      const ids = [...req.prompt.matchAll(/^- ((?:AC|S)\d+):/gm)].map((m) => m[1] as string);
      const mode = opts.application ?? "pass";
      const criteria = ids
        .filter((id) => !(mode === "missing" && id === ids[ids.length - 1]))
        .map((id, idx) => ({
          id,
          status: mode === "unmet" && idx === 0 ? "unmet" : "met",
          summary: `Checked ${id}.`,
          evidence: mode === "no-evidence" ? [] : [{ command: `node wordcount.js sample-${id}.txt`, exit_code: 0, output_excerpt: "sample: 5\ntotal: 5" }],
        }));
      return ok(JSON.stringify({ criteria, notes: "" }));
    }
    if (purpose === "plain-choices") return ok(["- Words are counted by splitting on spaces.", "- A missing file is reported but never stops the other files."].join("\n"));
    if (purpose === "github-lookup-summary") return ok("Reuse the CLI layout from o/wc.");
    if (purpose === "research-crosscheck") {
      return ok(JSON.stringify(opts.crosscheck ?? { verdict: "pass", summary: "All good.", claims: [{ claim: "a finding", status: "supported", note: "" }] }));
    }
    return ok("{}");
  };
  return { call, log };
}

