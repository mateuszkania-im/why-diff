/**
 * Shopping cart totals. All money values are integer cents.
 */

/** unitPrice * quantity for one line. */
export function lineTotal(item) {
  return item.unitPrice * item.quantity;
}

/** Sum of all line totals. */
export function subtotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

/**
 * Grand total: the discount (fraction, e.g. 0.1) comes off the subtotal first,
 * then tax (fraction) is applied to the discounted amount. Rounded to cents at each step.
 */
export function total(items, { discount = 0, taxRate = 0 } = {}) {
  const sub = subtotal(items);
  const discounted = sub - Math.round(sub * discount);
  const tax = Math.round(discounted * taxRate);
  return discounted + tax;
}
