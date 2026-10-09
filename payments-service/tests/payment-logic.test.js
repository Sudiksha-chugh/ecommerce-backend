const { processPayment } = require('../src/payment-logic');

describe('processPayment', () => {
  it('returns a result with the correct orderId, userId, and amount', () => {
    const order = { orderId: 1, userId: 5, amount: '99.99' };
    const result = processPayment(order);

    expect(result.orderId).toBe(1);
    expect(result.userId).toBe(5);
    expect(result.amount).toBe('99.99');
  });

  it('returns either "succeeded" or "failed" as the status', () => {
    const order = { orderId: 2, userId: 3, amount: '10.00' };
    const result = processPayment(order);

    expect(['succeeded', 'failed']).toContain(result.status);
  });
});