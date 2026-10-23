// Creates the throwaway git repositories for the Suite 9 live runs (docs/osa/TEST_REPORT.md): one folder per configuration, each with one commit and its own
// osa.config.json. Usage: node scripts/e2e-setup.mjs <root-dir>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const root = (process.argv[2] ?? "C:/Users/hp/osa-e2e").split(String.fromCharCode(92)).join("/");
const CBM = { engine: "cbm", cbm: { binaryPath: "C:/osa-cbm/bin/codebase-memory-mcp.exe", workDir: "C:/osa-cbm", indexMode: "full" } };
const TRIM = { enabled: true, engine: "trim1", binaryPath: "C:/Users/hp/go/bin/trim.exe" };
const NOTRIM = { enabled: false };
const variants = {
  "cli-full": { index: CBM, trim: TRIM },
  "cli-nocbm": { index: { engine: "lexical" }, trim: TRIM },
  "cli-notrim": { index: CBM, trim: NOTRIM },
  "cli-neither": { index: { engine: "lexical" }, trim: NOTRIM },
  "app-full": { index: CBM, trim: TRIM },
  "cli-nocbm2": { index: { engine: "lexical" }, trim: TRIM }, // rerun of cli-nocbm after the C5 fix stopped the first one
  "cli-verify": { index: CBM, trim: TRIM }, // run 1 again after the verbatim-request fix
  "cli-nocbm3": { index: { engine: "lexical" }, trim: TRIM }, // the no-CBM counterpart of cli-verify (same code)
  "cli-verify2": { index: CBM, trim: TRIM }, // run 1 once more, after stated rules became acceptance criteria
  "cli-verify3": { index: CBM, trim: TRIM }, // and once more, after a commit-only block stopped verify2
  "cli-decisions": { index: CBM, trim: TRIM }, // the long prompt that STATES its decisions (ASCII-only words ...), on the final code
};
for (const [name, extra] of Object.entries(variants)) {
  const dir = `${root}/${name}`;
  if (existsSync(`${dir}/.git`)) continue; // idempotent: never touch a repo that already exists
  mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(`${dir}/README.md`, `# ${name}\n\nEmpty project for an OSA end-to-end test.\n`);
  writeFileSync(`${dir}/.gitignore`, "__pycache__/\n*.pyc\n.pytest_cache/\n.venv/\n");
  writeFileSync(`${dir}/osa.config.json`, JSON.stringify({ providers: { modelOverrides: { "codex-cli": "gpt-6-luna" } }, ...extra }, null, 2));
  git("add", "-A");
  git("-c", "user.name=osa-e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "initial");
}
process.stdout.write(`created ${Object.keys(variants).join(", ")} under ${root}\n`);
