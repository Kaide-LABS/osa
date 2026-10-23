// Is this module the program's entry point? Compares REAL paths: a CLI started through a symlink or Windows junction -- which is how `npm link`
// and `npm install -g` of a local folder expose it -- has `process.argv[1]` = the link path while `import.meta.url` is already the real path,
// so a plain path comparison is false and the program would exit silently without doing anything.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** True when `moduleUrl` (pass `import.meta.url`) is the file `argv1` (pass `process.argv[1]`) names, links resolved. */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  return real(fileURLToPath(moduleUrl)) === real(resolve(argv1));
}
