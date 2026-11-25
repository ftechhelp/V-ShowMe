// A tiny shopping cart used to test ShowMe.
const TAX_RATE = 0.21;

export function addItem(cart, item, quantity = 1) {
  const existing = cart.items.find((i) => i.id === item.id);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({ ...item, quantity });
  }
  return cart;
}

export function subtotal(cart) {
  return cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

export function total(cart) {
  const net = subtotal(cart);
  const discount = cart.coupon ? net * cart.coupon.percent : 0;
  return (net - discount) * (1 + TAX_RATE);
}
