// The only way the rest of OSA obtains a trimmer (WS10). With `trim.enabled: false` (the default), or `trim.engine: "noop"`, this returns the no-op
// trimmer WITHOUT loading the trim-1 module, probing for its binary, or spawning anything. Only when trim is enabled is `./trim1.ts` imported
// (dynamically) and the binary probed. `src/osa/modular-features.test.ts` proves the static import graph of every entry point never reaches `trim1.ts`.

import type { OsaConfig } from "../domain/osa-config.ts";
import type { runProcess } from "../util/exec.ts";
import { NoopTrimmer } from "./trimmer.ts";
import type { ContextTrimmer } from "./trimmer.ts";

/** The outcome of {@link resolveTrimmerLazily}. */
export interface ResolvedTrimmer {
  readonly trimmer: ContextTrimmer;
  /** Why the configured engine is not in use, else `null`. */
  readonly note: string | null;
}

/** Dependencies of {@link resolveTrimmerLazily} (test seams). */
export interface ResolveDeps {
  readonly runProcessFn?: typeof runProcess;
  readonly cwd?: string;
}

/** Picks the trimmer for `trim` config; loads trim-1 only if it is enabled. */
export async function resolveTrimmerLazily(trim: OsaConfig["trim"], deps: ResolveDeps = {}): Promise<ResolvedTrimmer> {
  if (!trim.enabled) return { trimmer: new NoopTrimmer("trim.enabled is false"), note: "trim.enabled is false" };
  if (trim.engine === "noop") return { trimmer: new NoopTrimmer("trim.engine is noop"), note: "trim.engine is noop" };
  const { resolveTrimmer } = await import("./trim1.ts");
  return resolveTrimmer(trim, deps);
}
