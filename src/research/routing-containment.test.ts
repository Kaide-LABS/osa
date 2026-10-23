import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseResearchProviders } from "./routing.ts";
import { ADAPTER_REGISTRY } from "../adapters/registry.ts";
import { isTextCapable } from "../ports/text-provider.ts";

const hasWeb = (p: string): boolean => p !== "antigravity-cli";
const noFile = (p: string): boolean => p === "claude-code";

test("the provider with NO file access while browsing researches, whichever order the pair is in", () => {
  const a = chooseResearchProviders(["claude-code", "codex-cli"], hasWeb, noFile);
  assert.equal(a.researcher, "claude-code");
  assert.equal(a.reviewer, "codex-cli");
  assert.equal(a.routedAway, false);
  const b = chooseResearchProviders(["codex-cli", "claude-code"], hasWeb, noFile);
  assert.equal(b.researcher, "claude-code", "Codex can read local files while browsing, so it does not research when Claude can");
  assert.equal(b.reviewer, "codex-cli");
  assert.equal(b.routedAway, true);
  assert.match(b.reason, /can read local files while browsing/);
});

test("without a containment preference, or when only one provider has web search, behaviour is unchanged", () => {
  assert.equal(chooseResearchProviders(["codex-cli", "claude-code"], hasWeb).researcher, "codex-cli");
  const c = chooseResearchProviders(["antigravity-cli", "claude-code"], hasWeb, noFile);
  assert.equal(c.researcher, "claude-code");
  assert.match(c.reason, /no built-in web search/);
  assert.throws(() => chooseResearchProviders(["antigravity-cli", "antigravity-cli"], hasWeb, noFile), /two different providers/);
});

test("the real adapters declare their web containment (live-verified in redteam-live.test.ts)", () => {
  const caps = (id: "claude-code" | "codex-cli") => {
    const a = ADAPTER_REGISTRY[id];
    assert.ok(isTextCapable(a));
    return a.textCapabilities.webContainment;
  };
  assert.equal(caps("claude-code"), "no-file-access");
  assert.equal(caps("codex-cli"), "read-only-files");
});
