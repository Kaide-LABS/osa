// Implements PHASE_2_SPEC.md §6.4
//
// The shared, provider-agnostic adapter conformance suite. `claude-code.test.ts` and
// `codex-cli.test.ts` each call `assertAdapterConformance()` once, against their own adapter
// instance and a locally-built `TurnRequest` fixture, so the same contract is verified
// identically for every provider rather than reimplemented per file -- the drift risk PRD §9 FM9
// already names for production code, applied here to test code (see this file's own listing in
// PHASE_2_SPEC.md §1.1: "Not itself a *.test.ts file: it is a reusable assertion library,
// consistent with src/verify/git.ts being a non-test helper consumed by multiple test files").

import assert from "node:assert/strict";
import { TurnTimeoutError } from "../domain/errors.ts";
import { MODEL_TIERS } from "../domain/tiers.ts";
import { PROVIDER_IDS } from "../domain/run.ts";
import type { ProviderId, RawInvocationResult, TurnRequest } from "../domain/run.ts";
import type { ProviderAdapter } from "../ports/provider-adapter.ts";
import { ADAPTER_REGISTRY } from "./registry.ts";
import { CLAUDE_EFFORT_VALUES } from "./claude-code.ts";
import { CODEX_EFFORT_VALUES } from "./codex-cli.ts";
import { ANTIGRAVITY_EFFORT_VALUES } from "./antigravity-cli.ts";
import { OPENCODE_EFFORT_VALUES } from "./opencode-cli.ts";
import { COPILOT_EFFORT_VALUES } from "./copilot-cli.ts";

const EFFORT_VALUE_SETS: Readonly<Record<ProviderId, readonly string[]>> = {
  "claude-code": CLAUDE_EFFORT_VALUES,
  "codex-cli": CODEX_EFFORT_VALUES,
  "antigravity-cli": ANTIGRAVITY_EFFORT_VALUES,
  "opencode-cli": OPENCODE_EFFORT_VALUES,
  "copilot-cli": COPILOT_EFFORT_VALUES,
};

/** Reuses PHASE_1_SPEC.md §4.2's own credential-looking-value shape, applied to `Invocation.env`. */
const CREDENTIAL_LOOKING_PATTERN = /(sk-|ghp_|xoxb-)[A-Za-z0-9_-]+/;

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function effortValueSetFor(adapter: ProviderAdapter): readonly string[] {
  return EFFORT_VALUE_SETS[adapter.id];
}

function fakeRaw(overrides: Partial<RawInvocationResult> = {}): RawInvocationResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    ...overrides,
  };
}

/**
 * [DET] Runs a fixed battery of `node:assert` checks against any {@link ProviderAdapter}
 * implementation and a representative {@link TurnRequest} fixture, throwing (failing the calling
 * test) on the first violation. Implements PHASE_2_SPEC.md §6.4, checks 1-8.
 */
export function assertAdapterConformance(adapter: ProviderAdapter, fixture: TurnRequest): void {
  // 1. Identity: adapter.id is a member of PROVIDER_IDS, and ADAPTER_REGISTRY's entry for that id
  // reports the same id back (guards against a registry key/adapter-id mismatch).
  assert.ok(
    (PROVIDER_IDS as readonly string[]).includes(adapter.id),
    `adapter.id "${adapter.id}" is not a member of PROVIDER_IDS`,
  );
  const registryEntry = ADAPTER_REGISTRY[adapter.id];
  assert.strictEqual(
    registryEntry.id,
    adapter.id,
    `ADAPTER_REGISTRY["${adapter.id}"].id does not match adapter.id`,
  );

  // 2/3. resolveEffort totality, value-set membership, and purity.
  const effortValues = effortValueSetFor(adapter);
  for (const tier of MODEL_TIERS) {
    const first = adapter.resolveEffort(tier);
    assert.strictEqual(typeof first, "string", `resolveEffort(${tier}) did not return a string`);
    assert.ok(
      effortValues.includes(first),
      `resolveEffort(${tier}) -> "${first}" is not a member of ${adapter.id}'s own effort value set`,
    );
    const second = adapter.resolveEffort(tier);
    assert.strictEqual(second, first, `resolveEffort(${tier}) is not pure across two calls`);
  }

  // 4. buildInvocation purity, and the fixture itself is not mutated by the call.
  const preCallClone = deepClone(fixture);
  const first = adapter.buildInvocation(fixture);
  const second = adapter.buildInvocation(deepClone(fixture));
  assert.deepStrictEqual(
    second,
    first,
    "buildInvocation is not pure: two structurally-equal fixtures produced different Invocation values",
  );
  assert.deepStrictEqual(fixture, preCallClone, "buildInvocation mutated its input TurnRequest");

  // 5. No forbidden flags, regardless of adapter.
  assert.ok(!first.args.includes("--bare"), "Invocation.args must never contain --bare");
  if (adapter.id === "codex-cli") {
    assert.ok(!first.args.includes("-a"), "codex-cli Invocation.args must never contain -a");
    assert.ok(
      !first.args.includes("--ask-for-approval"),
      "codex-cli Invocation.args must never contain --ask-for-approval",
    );
    assert.ok(!first.args.includes("--full-auto"), "codex-cli Invocation.args must never contain --full-auto");
  }
  if (adapter.id === "antigravity-cli") {
    for (const flag of ["-c", "--continue", "--conversation", "--sandbox", "-i", "--prompt-interactive"]) {
      assert.ok(!first.args.includes(flag), `antigravity-cli must not emit ${flag}`);
    }
    for (const flag of ["--dangerously-skip-permissions", "--disable-slash-commands", "--print-timeout"]) {
      assert.ok(first.args.includes(flag), `antigravity-cli must emit ${flag}`);
    }
  }

  // 6. env is an additive overlay, never a forged credential value.
  for (const value of Object.values(first.env)) {
    assert.ok(
      !CREDENTIAL_LOOKING_PATTERN.test(value),
      `Invocation.env contains a credential-looking value: "${value}"`,
    );
  }

  // 7. interpretResult timeout precedence: a deliberately contradictory fixture (timedOut: true,
  // exitCode: 0) must still resolve as a timeout failure, proving the check is unconditional.
  const timeoutOutcome = adapter.interpretResult(fakeRaw({ timedOut: true, exitCode: 0 }));
  assert.strictEqual(timeoutOutcome.ok, false, "interpretResult must report ok: false for a timed-out raw result");
  assert.ok(
    timeoutOutcome.failure instanceof TurnTimeoutError,
    "interpretResult must return a TurnTimeoutError for a timed-out raw result",
  );
  assert.strictEqual(timeoutOutcome.record, null);

  // 8. interpretResult.record is always null, for every fixture this suite constructs.
  const successOutcome = adapter.interpretResult(fakeRaw({ exitCode: 0 }));
  const failureOutcome = adapter.interpretResult(fakeRaw({ exitCode: 1 }));
  assert.ok(first.args.every((arg) => arg.length <= 1024), "prompt must never be placed on argv");
  assert.strictEqual(successOutcome.ok, false, "an empty successful process must not be successful");
  assert.strictEqual(successOutcome.record, null);
  assert.strictEqual(failureOutcome.record, null);
}
