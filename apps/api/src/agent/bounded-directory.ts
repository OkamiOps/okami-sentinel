export interface BoundedCollection<T> {
  entries: T[];
  truncated: boolean;
}

/** Pulls at most one item beyond the public limit to detect truncation. */
export async function collectBounded<T>(
  source: AsyncIterable<T>,
  maxEntries: number,
): Promise<BoundedCollection<T>> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError("maxEntries must be a positive safe integer");
  }

  const entries: T[] = [];
  for await (const entry of source) {
    if (entries.length >= maxEntries) {
      return { entries, truncated: true };
    }
    entries.push(entry);
  }
  return { entries, truncated: false };
}
