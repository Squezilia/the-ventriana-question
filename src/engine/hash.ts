import crypto from "node:crypto";
import type { WorldState } from "../../contracts/types.ts";

/**
 * Computes a deterministic SHA-256 hash of WorldState for replay and resume verification.
 */
export function hashWorldState(state: WorldState): string {
  const canonical = stableStringify(state);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(",")}}`;
}
