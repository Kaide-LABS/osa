// Implements PHASE_2_SPEC.md §6.3
//
// The first `AdapterRegistry` value (PHASE_1_SPEC.md §3.6 explicitly deferred it here). Both
// adapters are stateless (no constructor arguments, no instance fields beyond the fixed `id`), so
// a single frozen module-level instance per provider is sufficient -- no factory function needed.

import type { AdapterRegistry } from "../ports/provider-adapter.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { CodexCliAdapter } from "./codex-cli.ts";
import { AntigravityCliAdapter } from "./antigravity-cli.ts";
import { OpenCodeCliAdapter } from "./opencode-cli.ts";
import { CopilotCliAdapter } from "./copilot-cli.ts";

/**
 * The provider registry. Provider identities may grow while each run remains a two-provider pair.
 * Implements PHASE_2_SPEC.md §6.3.
 */
export const ADAPTER_REGISTRY: AdapterRegistry = Object.freeze({
  "claude-code": new ClaudeCodeAdapter(),
  "codex-cli": new CodexCliAdapter(),
  "antigravity-cli": new AntigravityCliAdapter(),
  "opencode-cli": new OpenCodeCliAdapter(),
  "copilot-cli": new CopilotCliAdapter(),
});
