/**
 * Strict ISO date parser. Rejects malformed strings and impossible calendar days
 * with a RangeError; never rolls a day over into the next month.
 */
const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseIsoDate(input) {
  const m = RE.exec(String(input));
  if (!m) throw new RangeError(`not an ISO date: ${input}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) throw new RangeError(`invalid month: ${input}`);
  if (day < 1 || day > daysInMonth(year, month)) throw new RangeError(`invalid day: ${input}`);
  return { year, month, day };
}
