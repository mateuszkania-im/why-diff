/**
 * Format integer cents as a money string, e.g. 123456 -> "$1,234.56".
 */
const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

function withCommas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatMoney(cents, currency = 'USD') {
  if (!Number.isInteger(cents)) throw new TypeError('cents must be an integer');
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}${symbol}${withCommas(whole)}.${rest}`;
}
