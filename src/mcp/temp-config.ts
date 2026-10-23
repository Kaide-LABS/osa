// Implements PHASE_8_SPEC.md §6.1a, §7 FM-M5
//
// Shared by src/mcp/tools/run.ts and src/mcp/tools/drive.ts -- both tools' underlying command
// function (runRunCommand/runDriveCommand) only accepts a config file path, never an in-memory
// object, so the already-SDK-validated RunConfig/DriveConfig object a tool handler receives as
// `args` must be written to a real file before either function can be called unmodified.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Writes `config` (already validated by the SDK against `RunConfig`/`DriveConfig` before this
 * function is ever called, PHASE_8_SPEC.md §3.1) as pretty-printed JSON to a freshly created,
 * process-exclusive temp directory, and returns the file's absolute path plus a `cleanup()`
 * function that removes the whole temp directory. The caller (`run.ts`/`drive.ts`'s own handler)
 * is responsible for calling `cleanup()` in a `finally` block so the temp file is removed whether
 * the subsequent `runRunCommand`/`runDriveCommand` call succeeds, returns a non-ok report, or
 * throws -- mirrors `src/cli/doctor.ts`'s own `lockSmokeTest()` `mkdtemp`/`try`/`finally`/`rm`
 * idiom exactly, factored out once here rather than duplicated across `run.ts` and `drive.ts`
 * separately. Implements PHASE_8_SPEC.md §6.1a, §7 FM-M5.
 */
export async function writeTempConfigFile(
  config: Record<string, unknown>,
): Promise<{ readonly configPath: string; readonly cleanup: () => Promise<void> }> {
  const tempDir = await mkdtemp(join(tmpdir(), "osa-mcp-"));
  const configPath = join(tempDir, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  return {
    configPath,
    cleanup: () =>
      rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).then(
        () => undefined,
        () => undefined,
      ),
  };
}
