/**
 * Working-day helpers. Saturday and Sunday are weekend days; no holiday calendar.
 */

/** True on Saturday and Sunday. */
export function isWeekend(date) {
  const day = date.getDay(); // 0 = Sunday ... 6 = Saturday
  return day === 6 || day === 7;
}

/** A new Date `n` business days (Mon-Fri) after `date`. Does not mutate the input. */
export function addBusinessDays(date, n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n must be a non-negative integer');
  const d = new Date(date.getTime());
  let remaining = n;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (!isWeekend(d)) remaining--;
  }
  return d;
}
