function processPayment(order) {
  const isSuccess =
    process.env.FORCE_PAYMENT_FAILURE === 'true'
      ? false
      : process.env.PAYMENT_OUTCOME !== 'failed';

  return {
    orderId: order.orderId,
    userId: order.userId,
    amount: order.amount,
    status: isSuccess ? 'succeeded' : 'failed',
  };
}

function processRefund(refundRequest) {
  return {
    orderId: refundRequest.orderId,
    userId: refundRequest.userId,
    amount: refundRequest.amount,
    status: process.env.REFUND_OUTCOME === 'failed' ? 'failed' : 'refunded',
  };
}

module.exports = { processPayment, processRefund };