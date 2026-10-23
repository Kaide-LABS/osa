// Loads the OSA project config: `osa.config.json`. A missing file is not an
// error -- every key has a default. A present-but-invalid file is a loud `UsageError` (exit 2).

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CONFIG_FILE_NAME } from "../domain/brand.ts";
import { UsageError } from "../domain/errors.ts";
import { OsaConfig } from "../domain/osa-config.ts";
import type { ExplicitFeatureKeys } from "../features/features.ts";
import { NO_EXPLICIT_KEYS } from "../features/features.ts";

/** The result of {@link loadOsaConfig}. */
export interface LoadedOsaConfig {
  readonly config: OsaConfig;
  /** Which file the config came from, or `null` when none exists and defaults apply. */
  readonly source: "osa.config.json" | null;
  /** Deprecation / shadowing notices, in order. Always present, `[]` when there are none. */
  readonly warnings: readonly string[];
  /** Which feature switches the file sets itself (everything else is a default): feeds `osa features` and the `feature_state` event. */
  readonly explicit: ExplicitFeatureKeys;
}

/** Which of the feature switches appear in the raw JSON of the config file. Pure. */
export function explicitFeatureKeys(json: unknown): ExplicitFeatureKeys {
  const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const root = obj(json);
  return {
    indexEngine: "engine" in obj(root["index"]),
    trim: "enabled" in obj(root["trim"]),
    quoteStatedRules: "quoteStatedRules" in obj(root["intake"]),
  };
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new UsageError(`Failed to read config file "${path}": ${err instanceof Error ? err.message : String(err)}`, { path });
  }
}

function parseConfigText(text: string, path: string): { readonly config: OsaConfig; readonly explicit: ExplicitFeatureKeys } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`Config file "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { path });
  }
  const result = OsaConfig.safeParse(json);
  if (!result.success) {
    throw new UsageError(`Config file "${path}" failed validation: ${z.prettifyError(result.error)}`, { path });
  }
  return { config: result.data, explicit: explicitFeatureKeys(json) };
}

/** Loads the config for `repoDir` (see the module comment for the lookup order). */
export async function loadOsaConfig(repoDir: string): Promise<LoadedOsaConfig> {
  const primaryPath = `${repoDir}/${CONFIG_FILE_NAME}`;
  const primary = await readIfExists(primaryPath);

  if (primary !== null) {
    return { ...parseConfigText(primary, primaryPath), source: CONFIG_FILE_NAME, warnings: [] };
  }
  return { config: OsaConfig.parse({}), source: null, warnings: [], explicit: NO_EXPLICIT_KEYS };
}
