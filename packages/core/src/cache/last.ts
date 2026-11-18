/**
 * The last element that matches, or undefined. The project's lib target
 * predates `Array.prototype.findLast`, and "last appended wins" is the rule
 * every store and the session rely on, so it lives in one place.
 */
export function findLast<T>(
  items: readonly T[],
  matches: (item: T) => boolean,
): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && matches(item)) return item;
  }
  return undefined;
}
