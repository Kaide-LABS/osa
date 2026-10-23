// Implements PHASE_1_SPEC.md §1.6 -- boundary.test.ts
// Covers §8 acceptance criterion #24: each of B1-B8 has a positive and a negative fixture test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { scanBoundary } from "./boundary.ts";
import type { BoundaryRule } from "./boundary-rules.ts";

async function fixtureRepo(
  sourceFiles: Readonly<Record<string, string>>,
  packageJson: unknown = { dependencies: { zod: "4.4.3" } },
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(`${tmpdir()}/osa-boundary-test-`);
  for (const [relPath, content] of Object.entries(sourceFiles)) {
    const abs = `${dir}/${relPath}`;
    await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await writeFile(`${dir}/package.json`, JSON.stringify(packageJson), "utf8");
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function hasRule(violations: readonly { rule: BoundaryRule["id"] }[], id: BoundaryRule["id"]): boolean {
  return violations.some((v) => v.rule === id);
}

test("B1: fires on a case-insensitive Traycer literal, silent on clean code", async () => {
  const positive = await fixtureRepo({ "src/fixture.ts": 'export const x = "TRAYCER_HOST_URL";\n' });
  try {
    assert.ok(hasRule(await scanBoundary(positive.dir), "B1"));
  } finally {
    await positive.cleanup();
  }

  const negative = await fixtureRepo({ "src/fixture.ts": 'export const x = "clean code";\n' });
  try {
    assert.ok(!hasRule(await scanBoundary(negative.dir), "B1"));
  } finally {
    await negative.cleanup();
  }
});

test("B2: fires on a non-zod runtime dependency, silent when dependencies is zod-only", async () => {
  const positive = await fixtureRepo(
    { "src/fixture.ts": "export const x = 1;\n" },
    { dependencies: { zod: "4.4.3", axios: "1.0.0" } },
  );
  try {
    const violations = await scanBoundary(positive.dir);
    assert.ok(hasRule(violations, "B2"));
    assert.ok(violations.some((v) => v.rule === "B2" && v.excerpt === "axios"));
  } finally {
    await positive.cleanup();
  }

  const negative = await fixtureRepo({ "src/fixture.ts": "export const x = 1;\n" }, { dependencies: { zod: "4.4.3" } });
  try {
    assert.ok(!hasRule(await scanBoundary(negative.dir), "B2"));
  } finally {
    await negative.cleanup();
  }
});

test("B2 (amended, PHASE_8_SPEC.md §7 FM-M3): silent on the closed two-key allowlist (zod + @modelcontextprotocol/sdk), still fires on a third, unauthorized dependency key added alongside both", async () => {
  const allowed = await fixtureRepo(
    { "src/fixture.ts": "export const x = 1;\n" },
    { dependencies: { zod: "4.4.3", "@modelcontextprotocol/sdk": "1.30.0" } },
  );
  try {
    assert.ok(!hasRule(await scanBoundary(allowed.dir), "B2"));
  } finally {
    await allowed.cleanup();
  }

  const thirdDependency = await fixtureRepo(
    { "src/fixture.ts": "export const x = 1;\n" },
    { dependencies: { zod: "4.4.3", "@modelcontextprotocol/sdk": "1.30.0", "third-pkg": "1.0.0" } },
  );
  try {
    const violations = await scanBoundary(thirdDependency.dir);
    assert.ok(hasRule(violations, "B2"));
    assert.ok(violations.some((v) => v.rule === "B2" && v.excerpt === "third-pkg"));
    assert.equal(violations.filter((v) => v.rule === "B2").length, 1);
  } finally {
    await thirdDependency.cleanup();
  }
});

test("B3: fires on a node:net import, silent on a zod-only import", async () => {
  const positive = await fixtureRepo({ "src/fixture.ts": 'import net from "node:net";\n' });
  try {
    assert.ok(hasRule(await scanBoundary(positive.dir), "B3"));
  } finally {
    await positive.cleanup();
  }

  const negative = await fixtureRepo({ "src/fixture.ts": 'import { z } from "zod";\n' });
  try {
    assert.ok(!hasRule(await scanBoundary(negative.dir), "B3"));
  } finally {
    await negative.cleanup();
  }
});

test("B3: fires on a bare fetch() call", async () => {
  const positive = await fixtureRepo({ "src/fixture.ts": "export function go() { return fetch(\"x\"); }\n" });
  try {
    assert.ok(hasRule(await scanBoundary(positive.dir), "B3"));
  } finally {
    await positive.cleanup();
  }
});

test("B4: fires on a real https:// string literal, silent when the same text is only in a comment", async () => {
  const positive = await fixtureRepo({ "src/fixture.ts": 'export const url = "https://example.com";\n' });
  try {
    assert.ok(hasRule(await scanBoundary(positive.dir), "B4"));
  } finally {
    await positive.cleanup();
  }

  const negative = await fixtureRepo({
    "src/fixture.ts": "// see https://example.com for background\nexport const x = 1;\n",
  });
  try {
    assert.ok(!hasRule(await scanBoundary(negative.dir), "B4"));
  } finally {
    await negative.cleanup();
  }
});

test("B5: fires on importing `open`, silent on an unrelated import", async () => {
  const positive = await fixtureRepo({ "src/fixture.ts": 'import open from "open";\n' });
  try {
    assert.ok(hasRule(await scanBoundary(positive.dir), "B5"));
  } finally {
    await positive.cleanup();
  }

  const negative = await fixtureRepo({ "src/fixture.ts": 'import { z } from "zod";\n' });
  try {
    assert.ok(!hasRule(await scanBoundary(negative.dir), "B5"));
  } finally {
    await negative.cleanup();
  }
});

test("B6: fires on a literal credential-setup invocation, silent on an auth/login *status* probe", async () => {
  const positive = await fixtureRepo({ "src/fixture.ts": 'export const cmd = "claude auth login";\n' });
  try {
    assert.ok(hasRule(await scanBoundary(positive.dir), "B6"));
  } finally {
    await positive.cleanup();
  }

  const negative = await fixtureRepo({
    "src/fixture.ts": 'export const cmd1 = "claude auth status"; export const cmd2 = "codex login status";\n',
  });
  try {
    assert.ok(!hasRule(await scanBoundary(negative.dir), "B6"));
  } finally {
    await negative.cleanup();
  }
});

test("B7: fires on a concrete model name and on a bare tier alias, silent on an abstract ModelTier value", async () => {
  const positive = await fixtureRepo({ "src/fixture.ts": 'export const model = "claude-sonnet-4.5";\n' });
  try {
    assert.ok(hasRule(await scanBoundary(positive.dir), "B7"));
  } finally {
    await positive.cleanup();
  }

  const positiveAlias = await fixtureRepo({ "src/fixture.ts": 'export const tier = "sonnet";\n' });
  try {
    assert.ok(hasRule(await scanBoundary(positiveAlias.dir), "B7"));
  } finally {
    await positiveAlias.cleanup();
  }

  const negative = await fixtureRepo({ "src/fixture.ts": 'export const tier = "high-volume-low-effort";\n' });
  try {
    assert.ok(!hasRule(await scanBoundary(negative.dir), "B7"));
  } finally {
    await negative.cleanup();
  }
});

test("B7: is exempt for files under src/adapters/", async () => {
  const fixture = await fixtureRepo({ "src/adapters/claude-adapter.ts": 'export const model = "claude-opus-5";\n' });
  try {
    assert.ok(!hasRule(await scanBoundary(fixture.dir), "B7"));
  } finally {
    await fixture.cleanup();
  }
});

test("B8: fires on a commit-attribution trailer string, silent on a neutral commit template", async () => {
  const positive = await fixtureRepo({
    "src/fixture.ts": 'export const template = "Co-Authored-By: Claude <noreply@anthropic.com>";\n',
  });
  try {
    assert.ok(hasRule(await scanBoundary(positive.dir), "B8"));
  } finally {
    await positive.cleanup();
  }

  const negative = await fixtureRepo({ "src/fixture.ts": 'export const template = "feat: implement the thing";\n' });
  try {
    assert.ok(!hasRule(await scanBoundary(negative.dir), "B8"));
  } finally {
    await negative.cleanup();
  }
});

test("*.test.ts files are excluded from the scan even when they contain forbidden literals", async () => {
  const fixture = await fixtureRepo({ "src/fixture.test.ts": 'export const x = "TRAYCER";\n' });
  try {
    assert.deepStrictEqual(await scanBoundary(fixture.dir), []);
  } finally {
    await fixture.cleanup();
  }
});

test("scanBoundary reports every violation, not just the first", async () => {
  const fixture = await fixtureRepo({
    "src/fixture.ts": 'export const a = "TRAYCER";\nexport const b = "https://example.com";\n',
  });
  try {
    const violations = await scanBoundary(fixture.dir);
    assert.ok(hasRule(violations, "B1"));
    assert.ok(hasRule(violations, "B4"));
  } finally {
    await fixture.cleanup();
  }
});

test("scanBoundary(process.cwd()) on OSA's own real src tree reports zero violations", async () => {
  const violations = await scanBoundary(process.cwd());
  assert.deepStrictEqual(violations, []);
});

test("network exemption: fetch() and https:// literals are allowed ONLY under src/research/net/ (B3/B4 exempt)", async () => {
  const code = 'export async function go() { const r = await fetch("https://api.example.org/x"); return r.text(); }\n';
  const inside = await fixtureRepo({ "src/research/net/client.ts": code });
  try {
    const v = await scanBoundary(inside.dir);
    assert.ok(!hasRule(v, "B3") && !hasRule(v, "B4") && !hasRule(v, "B9"), JSON.stringify(v));
  } finally {
    await inside.cleanup();
  }
  for (const where of ["src/research/client.ts", "src/research/netx/client.ts", "src/other/client.ts"]) {
    const outside = await fixtureRepo({ [where]: code });
    try {
      const v = await scanBoundary(outside.dir);
      assert.ok(hasRule(v, "B3") && hasRule(v, "B4"), `${where} must still violate B3/B4`);
    } finally {
      await outside.cleanup();
    }
  }
});

test("B9: inside the exempt directory only global fetch is allowed -- no node:https, undici, axios, got, node-fetch, XMLHttpRequest", async () => {
  for (const line of ['import https from "node:https";', 'import { fetch } from "undici";', 'import axios from "axios";', 'import got from "got";', "const x = new XMLHttpRequest();"]) {
    const f = await fixtureRepo({ "src/research/net/client.ts": `${line}\n` });
    try {
      assert.ok(hasRule(await scanBoundary(f.dir), "B9"), line);
    } finally {
      await f.cleanup();
    }
  }
  const clean = await fixtureRepo({ "src/research/net/client.ts": "export const ok = 1;\n" });
  try {
    assert.ok(!hasRule(await scanBoundary(clean.dir), "B9"));
  } finally {
    await clean.cleanup();
  }
  // B9 is meaningless outside the exempt dir (B3 already covers it there): it must not double-report.
  const outside = await fixtureRepo({ "src/fixture.ts": 'import https from "node:https";\n' });
  try {
    const v = await scanBoundary(outside.dir);
    assert.ok(hasRule(v, "B3") && !hasRule(v, "B9"));
  } finally {
    await outside.cleanup();
  }
});
