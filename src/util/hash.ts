// Implements PHASE_1_SPEC.md §6.2
//
// [DET] The AC3 artifact-attestation primitive (PRD §7 I2): SHA-256 over file bytes, compared
// mechanically rather than by asking an agent whether it read or wrote a file.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** SHA-256 of a string, as lowercase hex -- matches the `Sha256Hex` regex (`src/domain/relay.ts`). */
export function sha256String(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** SHA-256 of a file's bytes, as lowercase hex. Streams the file rather than reading it whole. */
export function sha256File(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("data", (chunk: Buffer) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
    stream.on("error", (err: Error) => {
      reject(err);
    });
  });
}
