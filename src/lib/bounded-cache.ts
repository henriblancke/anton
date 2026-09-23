/** A weighted LRU for derived, disposable values. Oversized entries are never retained. */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, { value: V; weight: number }>();
  private weight = 0;

  constructor(private readonly maxWeight: number, private readonly maxEntries = 10_000) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, weight = 1): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.weight -= previous.weight;
      this.entries.delete(key);
    }
    if (weight > this.maxWeight || this.maxEntries < 1) return;
    this.entries.set(key, { value, weight });
    this.weight += weight;
    while (this.weight > this.maxWeight || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as K;
      this.weight -= this.entries.get(oldest)!.weight;
      this.entries.delete(oldest);
    }
  }
}
