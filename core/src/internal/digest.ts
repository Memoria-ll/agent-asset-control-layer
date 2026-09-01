import { createHash } from "node:crypto";

/** Compute the hexadecimal SHA-256 digest used by Core's canonical revisions. */
export const sha256Hex = (input: string): string =>
  createHash("sha256").update(Buffer.from(input, "utf8")).digest("hex");
