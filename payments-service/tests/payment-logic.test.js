const { processPayment } = require('../src/payment-logic');

describe('processPayment', () => {
  it('returns a result with the correct orderId, userId, and amount', () => {
    const order = { id: 1, user_id: 5, total_amount: '99.99' };
    const result = processPayment(order);

    expect(result.orderId).toBe(1);
    expect(result.userId).toBe(5);
    expect(result.amount).toBe('99.99');
  });

  it('returns either "succeeded" or "failed" as the status', () => {
    const order = { id: 2, user_id: 3, total_amount: '10.00' };
    const result = processPayment(order);

    expect(['succeeded', 'failed']).toContain(result.status);
  });
});