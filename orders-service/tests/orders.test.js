const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const pool = require('../src/db');
require('dotenv').config();

function makeToken(userId) {
  return jwt.sign({ userId, email: `${userId}@example.com` }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('POST /orders', () => {
  const token = makeToken(1);

  afterEach(async () => {
    await pool.query('DELETE FROM outbox_events');
    await pool.query('DELETE FROM orders');
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rejects requests with no token with 401', async () => {
    const res = await request(app)
      .post('/orders')
      .send({
        items: [{ productId: 2, name: 'USB-C Hub', price: 34.99, quantity: 3 }],
        totalAmount: 104.97,
      });

    expect(res.statusCode).toBe(401);
  });

  it('creates a new order using the userId from the token', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: 2, name: 'USB-C Hub', price: 34.99, quantity: 3 }],
        totalAmount: 104.97,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.user_id).toBe(1);
    expect(res.body.status).toBe('pending');
  });

  it('rejects an order with missing items with 400', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ totalAmount: 104.97 });

    expect(res.statusCode).toBe(400);
  });

  it('writes an outbox_events row in the same transaction as the order', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: 2, name: 'USB-C Hub', price: 34.99, quantity: 3 }],
        totalAmount: 104.97,
      });

    expect(res.statusCode).toBe(201);

    const outboxCheck = await pool.query(
      "SELECT * FROM outbox_events WHERE event_type = 'order_placed' AND payload->>'id' = $1",
      [String(res.body.id)]
    );

    expect(outboxCheck.rows.length).toBe(1);
    expect(outboxCheck.rows[0].published).toBe(false);
  });

  it('rolls back the order if the outbox insert fails, leaving no trace of either', async () => {
    const realConnect = pool.connect.bind(pool);

   jest.spyOn(pool, 'connect').mockImplementationOnce(async () => {
      const client = await realConnect();
      const realQuery = client.query.bind(client);

      client.query = jest.fn((text, params) => {
        if (typeof text === 'string' && text.includes('INSERT INTO outbox_events')) {
          return Promise.reject(new Error('Simulated outbox insert failure'));
        }
        return realQuery(text, params);
      });

      return client;
    });

    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: 999, name: 'Should Not Persist', price: 1.23, quantity: 1 }],
        totalAmount: 1.23,
      });

    expect(res.statusCode).toBe(500);

    const orderCheck = await pool.query(
      "SELECT * FROM orders WHERE total_amount = '1.23'"
    );
    expect(orderCheck.rows.length).toBe(0);
  });
});