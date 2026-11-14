import type { Nation, WorldConfig } from "../../contracts/types.ts";
import type { SeededPRNG } from "./prng.ts";

/**
 * Generates a unique name for the given nation using syllable lists from world.yaml.
 * Tracks used names across the entire run (including dead agents).
 */
export function generateUniqueName(
  nation: Nation,
  world: WorldConfig,
  usedNames: Set<string>,
  prng: SeededPRNG
): string {
  const pool = world.syllables[nation];
  for (let attempt = 0; attempt < 200; attempt++) {
    const first = prng.pick(pool.first).trim();
    const useMiddle = prng.next() < 0.7;
    const middle = useMiddle ? prng.pick(pool.middle).trim() : "";
    const last = prng.pick(pool.last).trim();
    const raw = `${first}${middle}${last}`;
    const candidate = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  // Fallback with numeric suffix if syllable combinations are exhausted
  let idx = 2;
  while (true) {
    const base = `${prng.pick(pool.first).trim()}${prng.pick(pool.last).trim()}`;
    const candidate = `${base.charAt(0).toUpperCase() + base.slice(1).toLowerCase()}${idx}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    idx++;
  }
}
