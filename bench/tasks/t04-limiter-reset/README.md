# rate-limiter

Fixed-window rate limiter.

`new RateLimiter({ limit, windowMs })` and `allow(key, now = Date.now())`.
Exactly `limit` requests per key are allowed inside one window; the `limit + 1`th request in the
same window is rejected. Keys are independent. A new window starts the count over.
