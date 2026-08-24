/**
 * Even downsampling, shared by the loaders and the pure trajectory helpers.
 *
 * Indices are unique and sorted: rounding can map two targets onto the same
 * row, and a duplicate index would emit the same point twice rather than
 * simply thinning the series.
 */
export function evenlySampleIndices(length: number, target: number): number[] {
  if (length <= 0 || target <= 0) return [];
  if (target >= length) return Array.from({ length }, (_, index) => index);
  if (target === 1) return [0];

  const sampled = new Set<number>();
  for (let index = 0; index < target; index++) {
    sampled.add(Math.round((index * (length - 1)) / (target - 1)));
  }

  // Fill gaps left by rounding collisions so the caller still gets `target`
  // rows where the source has them.
  if (sampled.size < target) {
    for (let index = 0; index < length && sampled.size < target; index++) {
      sampled.add(index);
    }
  }

  return [...sampled].sort((a, b) => a - b);
}

export function evenlySampleArray<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount) return items;
  return evenlySampleIndices(items.length, maxCount).map(
    (index) => items[index],
  );
}
