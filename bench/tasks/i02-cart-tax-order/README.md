# cart

Shopping cart totals. All money values are integer cents.

- `lineTotal(item)`: `unitPrice * quantity`.
- `subtotal(items)`: sum of the line totals.
- `total(items, { discount, taxRate })`: the discount (a fraction, 0.1 = 10%) is taken off the
  subtotal first, then tax (a fraction) is applied to the discounted amount. Each step is rounded
  to the nearest cent.
