# lru-cache

`new LruCache(capacity)`: a least-recently-used cache.

- `get(key)` returns the value (or `undefined`) and marks the key as most recently used
- `set(key, value)` inserts or updates and marks the key as most recently used; when the cache is
  over capacity the least recently used entry is evicted
- `has(key)` and `size` do not affect recency
