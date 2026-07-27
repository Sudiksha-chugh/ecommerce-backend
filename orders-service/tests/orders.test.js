const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db');

describe('POST /orders', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM orders');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates a new order and returns 201 with order details', async () => {
    const res = await request(app)
      .post('/orders')
      .send({
        userId: 1,
        items: [{ productId: 2, name: 'USB-C Hub', price: 34.99, quantity: 3 }],
        totalAmount: 104.97,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.user_id).toBe(1);
    expect(res.body.status).toBe('pending');
    expect(res.body.total_amount).toBe('104.97');
  });

  it('rejects an order with missing userId with 400', async () => {
    const res = await request(app)
      .post('/orders')
      .send({
        items: [{ productId: 2, name: 'USB-C Hub', price: 34.99, quantity: 3 }],
        totalAmount: 104.97,
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('rejects an order with missing items with 400', async () => {
    const res = await request(app)
      .post('/orders')
      .send({
        userId: 1,
        totalAmount: 104.97,
      });

    expect(res.statusCode).toBe(400);
  });
});