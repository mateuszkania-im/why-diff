/**
 * Turn a string into a URL slug: lowercase, runs of non-alphanumerics become a
 * single hyphen, no leading or trailing hyphens.
 */
export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '');
}
