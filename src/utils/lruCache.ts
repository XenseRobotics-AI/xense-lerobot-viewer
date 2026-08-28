/**
 * Insertion-ordered LRU helpers over a plain `Map`.
 *
 * A `Map` already iterates in insertion order, so "least recently used" only
 * needs a delete-then-set on every touch. The episode loaders had three
 * hand-rolled copies of that dance with three different eviction loops; one
 * of them skipped the delete on the hit path, which quietly made it FIFO
 * rather than LRU. Sharing the implementation is what keeps the eviction
 * policy the same in all three places.
 */

/**
 * Look a key up and, on a hit, move it to the newest end so it is evicted
 * last. Returns the value, or undefined when absent.
 */
export function touchLru<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key) as V;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/**
 * Insert (or refresh) an entry at the newest end and evict from the oldest
 * end until the cache is within `maxEntries`.
 *
 * `maxEntries < 1` is treated as "hold nothing": the value is not retained.
 */
export function rememberInLru<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
): void {
  cache.delete(key);
  if (maxEntries < 1) return;
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
