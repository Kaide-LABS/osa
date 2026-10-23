// Drives CBM through an index + queries + re-index so scripts/cbm-netwatch.ps1 can sample its sockets. Usage (two shells): powershell -File scripts/cbm-netwatch.ps1 ; node scripts/cbm-netrun.mjs  (needs the eval snapshots; see evals/code-search/README.md)
import { CbmEngine } from "../src/code-index/cbm/engine.ts";
import { LexicalEngine } from "../src/code-index/engine.ts";
import { TUNED_TUNING } from "../src/code-index/fusion.ts";
const root = "C:/Users/hp/osa-tools/eval-snapshots/hostel";
const e = await CbmEngine.open({ repoDir: root, paths: { binaryPath: "C:/osa-cbm/bin/codebase-memory-mcp.exe", workDir: "C:/osa-cbm" }, lexical: new LexicalEngine(root), tuning: TUNED_TUNING });
for (const q of ["where is the reservation limit checked", "what calls check_reserved_within_limit", "how is the explanation for a student built", "provider secret key leak error message", "architecture overview"]) await e.search(q, { k: 5 });
await e.refresh();
await e.close();
console.log("done");
