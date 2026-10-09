// Pure transition decisions; all effects are committed by sagaStore in one transaction.
function decide(saga, type, event = {}) {
  const s = { ...saga };
  const commands = [];
  const emit = (name) => commands.push(name);
  const release = () => { s.state = 'RELEASE_PENDING'; emit('inventory_release_requested'); };
  const refund = () => { s.state = 'REFUND_PENDING'; emit('refund_requested'); };
  const cancel = () => { s.state = 'CANCELLED'; s.orderStatus = 'cancelled'; };
  if (s.state === 'CANCELLED') return { saga: s, commands };
  switch (type) {
    case 'cancel_requested':
      s.cancel_requested = true;
      if (['PAYMENT_AUTHORIZED', 'CONFIRMED', 'REFUND_FAILED'].includes(s.state)) refund();
      else if (s.state === 'PENDING') {s.state = 'CANCEL_REQUESTED';s.orderStatus='cancellation_pending';}
      if(s.state === 'STOCK_RESERVED') s.orderStatus='cancellation_pending';
      // STOCK_RESERVED has a payment command in flight: wait for its outcome.
      break;
    case 'inventory_reserved':
      if (s.state === 'PENDING') { s.state = 'STOCK_RESERVED'; emit('payment_requested'); }
      else if (s.state === 'CANCEL_REQUESTED') release();
      break;
    case 'inventory_reservation_failed':
      if (['PENDING', 'CANCEL_REQUESTED'].includes(s.state)) { s.failure_state = 'STOCK_FAILED'; cancel(); }
      break;
    case 'payment_processed':
      if (s.state !== 'STOCK_RESERVED') break;
      if (event.status === 'succeeded') {
        s.payment_succeeded = true;
        if (s.cancel_requested || s.inventory_inactive) refund();
        else { s.state = 'PAYMENT_AUTHORIZED'; emit('inventory_confirm_requested'); }
      } else { s.failure_state = 'PAYMENT_FAILED'; release(); }
      break;
    case 'inventory_confirmed':
      if (s.state === 'PAYMENT_AUTHORIZED') { s.state = 'CONFIRMED'; s.orderStatus = 'succeeded'; }
      break;
    case 'inventory_expired':
    case 'inventory_confirmation_failed':
      s.cancel_requested = true;
      // Per-reservation expiration is not proof that the entire order is inactive.
      if (event.allInactive === true) s.inventory_inactive = true;
      if (s.state === 'PAYMENT_AUTHORIZED' || s.state === 'CONFIRMED') refund();
      else if (s.state === 'PENDING') s.state = 'CANCEL_REQUESTED';
      break;
    case 'refund_processed':
      if (s.state !== 'REFUND_PENDING') break;
      if (event.status === 'refunded') { s.refund_succeeded = true; release(); }
      else s.state = 'REFUND_FAILED';
      break;
    case 'inventory_released':
      if (s.state === 'RELEASE_PENDING') {
        s.inventory_inactive = true;
        if (!s.payment_succeeded || s.refund_succeeded) cancel();
      }
      break;
    default: throw new Error(`Unknown saga event: ${type}`);
  }
  if (s.state === 'REFUND_PENDING') s.orderStatus = 'refund_pending';
  else if (s.state === 'REFUND_FAILED') s.orderStatus = 'refund_failed';
  return { saga: s, commands };
}
module.exports = { decide };
