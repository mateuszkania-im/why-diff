export interface CartItem {
    name: string;
    price: number;
    qty: number;
}
export declare function cartTotal(items: CartItem[]): number;
