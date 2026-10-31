export interface CartItem {
  name: string;
  price: number;
  qty: number;
}

export function cartTotal(items: CartItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.price * item.qty;
  }
  return total;
}
