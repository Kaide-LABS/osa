// Checks that the embeddings endpoint you configured for the "hybrid" code search really works, with a real call and no mocks.
//
//   node scripts/embeddings-smoke.ts                     (reads index.semantic from ./osa.config.json)
//   node scripts/embeddings-smoke.ts --base-url <url> --model <name> [--key-env NAME]
//
// It embeds three short texts -- two that mean the same thing in different words, one unrelated -- and prints the similarities. PASS means the
// related pair is clearly closer than the unrelated one, which is the property the hybrid engine relies on.
import { readFileSync } from "node:fs";
import { OsaConfig } from "../src/domain/osa-config.ts";
import { cosine, embedTexts } from "../src/research/net/embeddings.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
let fromFile = OsaConfig.parse({}).index.semantic;
try {
  fromFile = OsaConfig.parse(JSON.parse(readFileSync("osa.config.json", "utf8"))).index.semantic;
} catch {
  // no config file: the flags must carry everything
}
const cfg = {
  baseUrl: arg("base-url") ?? fromFile.baseUrl,
  model: arg("model") ?? fromFile.model,
  apiKeyEnv: arg("key-env") ?? fromFile.apiKeyEnv,
  timeoutMs: fromFile.timeoutMs,
  batchSize: fromFile.batchSize,
};
if (cfg.baseUrl === "" || cfg.model === "") {
  process.stderr.write("Set index.semantic.baseUrl and index.semantic.model in osa.config.json, or pass --base-url and --model.\n");
  process.exit(2);
}
const texts = ["a function that slows down clients which send too many requests", "rate limiter: rejects callers over their per-minute quota", "reads the user's saved colour theme from the settings file"];
const t0 = Date.now();
const [a, b, c] = await embedTexts(cfg, texts).catch((err: unknown) => {
  process.stderr.write(`FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
const related = cosine(a as Float32Array, b as Float32Array);
const unrelated = Math.max(cosine(a as Float32Array, c as Float32Array), cosine(b as Float32Array, c as Float32Array));
process.stdout.write(`model ${cfg.model}: ${String((a as Float32Array).length)} dimensions, ${String(Date.now() - t0)} ms\nrelated pair  ${related.toFixed(3)}\nunrelated     ${unrelated.toFixed(3)}\n`);
const pass = related > unrelated + 0.05;
process.stdout.write(pass ? "PASS: related texts are clearly closer.\n" : "FAIL: the related pair is not clearly closer than the unrelated text; this model is not usable for code search.\n");
process.exitCode = pass ? 0 : 1;
