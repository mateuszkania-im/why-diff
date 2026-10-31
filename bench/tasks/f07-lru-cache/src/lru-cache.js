/**
 * Least-recently-used cache backed by a Map (insertion order = recency order,
 * oldest first).
 */
export class LruCache {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be an integer >= 1');
    this.capacity = capacity;
    this.map = new Map();
  }

  /** Value for key, or undefined. Marks the key as most recently used. */
  get(key) {
    return this.map.get(key);
  }

  /** Insert or update; evicts the least recently used entry when over capacity. */
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return this;
  }

  has(key) {
    return this.map.has(key);
  }

  get size() {
    return this.map.size;
  }
}
