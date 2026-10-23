// Runs after `tsc -p tsconfig.build.json`: records which source set dist/ was compiled from, so `osa doctor` can
// warn when dist/ goes stale. See src/verify/build-stamp.ts.
import { writeBuildStamp, packageRoot } from "../dist/verify/build-stamp.js";

const stamp = writeBuildStamp(packageRoot());
process.stdout.write(`build stamp ${stamp.source_hash.slice(0, 12)} (${String(stamp.file_count)} files)\n`);
