
function processPayment(order) {
  const isSuccess = Math.random() < 0.9;

  return {
    orderId: order.id,
    userId: order.user_id,
    amount: order.total_amount,
    status: isSuccess ? 'succeeded' : 'failed',
  };
}

function processRefund(refundRequest) {
  return {
    orderId: refundRequest.orderId,
    userId: refundRequest.userId,
    amount: refundRequest.amount,
    status: 'refunded',
  };
}

module.exports = { processPayment, processRefund };

