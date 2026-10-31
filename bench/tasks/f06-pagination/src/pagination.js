/**
 * Slice `items` into 1-based pages.
 * totalPages is ceil(total / pageSize) and at least 1.
 */
export function paginate(items, { page = 1, pageSize = 10 } = {}) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be an integer >= 1');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be an integer >= 1');
  const total = items.length;
  const totalPages = Math.max(1, Math.floor(total / pageSize));
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, total, totalPages };
}
