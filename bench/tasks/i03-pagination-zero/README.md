# pagination

`paginate(items, { page, pageSize })` returns `{ items, page, pageSize, total, totalPages }`.

- pages are 1-based; `page` and `pageSize` must be integers >= 1, otherwise a `RangeError` is thrown
- `totalPages = ceil(total / pageSize)`, but at least 1: an empty list has one empty page
- a page past the end returns an empty `items` array
