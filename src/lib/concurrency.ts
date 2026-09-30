/**
 * Run `fn` over `items` with at most `limit` promises in flight at once, preserving input order in
 * the returned array. Rejects as soon as any `fn` rejects (in-flight work is left to settle but its
 * result is discarded), matching the fail-fast behaviour of an awaited serial loop. A `limit` below
 * 1 is treated as 1; an empty `items` resolves to `[]` without calling `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
