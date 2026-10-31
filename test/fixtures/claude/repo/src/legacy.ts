export function legacyTotal(prices: number[]): number {
  return prices.reduce((a, b) => a + b, 0);
}
