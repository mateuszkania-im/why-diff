/**
 * Fixed-window rate limiter: exactly `limit` requests per key per window.
 */
export class RateLimiter {
  constructor({ limit, windowMs }) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be an integer >= 1');
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError('windowMs must be an integer >= 1');
    this.limit = limit;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  /** True if the request is allowed (and counted), false if the key is over its limit. */
  allow(key, now = Date.now()) {
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.windowStart !== windowStart) {
      bucket = { windowStart, count: 0 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.limit) return false;
    bucket.count++;
    return true;
  }
}
