// A project whose package.json lists dependencies but has no node_modules yet.
//
// Found in a real run: the first build turn saw the missing node_modules, started `npm install` in the
// background and ended its turn to wait for it, so the turn finished without its hand-over record.
// `doctor` reports it up front so the person installs first.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEPENDENCY_KEYS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** True when `<repoDir>/package.json` lists at least one dependency of any kind. */
function listsDependencies(packageJsonPath: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  return DEPENDENCY_KEYS.some((key) => {
    const value = record[key];
    return typeof value === "object" && value !== null && Object.keys(value).length > 0;
  });
}

/**
 * Warnings about the project's own setup that make a build turn fail in a confusing way. Empty for a
 * project with no package.json, no dependencies, or its dependencies already installed.
 */
export function projectDependencyWarnings(repoDir: string): string[] {
  const packageJsonPath = join(repoDir, "package.json");
  if (!existsSync(packageJsonPath) || !listsDependencies(packageJsonPath)) return [];
  if (existsSync(join(repoDir, "node_modules"))) return [];
  return [
    `package.json lists dependencies but node_modules is missing in ${repoDir}. Install them first (for example \`npm ci\` or \`npm install\`): ` +
      `otherwise the first build turn may start a long install in the background and end without writing its hand-over record.`,
  ];
}
