jest.mock('../src/rabbitmq');

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const pool = require('../src/db');
const { getChannel } = require('../src/rabbitmq');
require('dotenv').config();

function makeToken(userId) {
  return jwt.sign({ userId, email: `${userId}@example.com` }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('POST /orders', () => {
  const token = makeToken(1);

  afterEach(async () => {
    await pool.query('DELETE FROM orders');
    jest.clearAllMocks();
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

  it('creates a new order using the userId from the token, ignoring any userId in the body', async () => {
    getChannel.mockReturnValue({ sendToQueue: jest.fn() });

    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userId: 999,
        items: [{ productId: 2, name: 'USB-C Hub', price: 34.99, quantity: 3 }],
        totalAmount: 104.97,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.user_id).toBe(1);
    expect(res.body.status).toBe('pending');
    expect(res.body.total_amount).toBe('104.97');
  });

  it('rejects an order with missing items with 400', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ totalAmount: 104.97 });

    expect(res.statusCode).toBe(400);
  });

  it('publishes an order_placed message when RabbitMQ is available', async () => {
    const mockSendToQueue = jest.fn();
    getChannel.mockReturnValue({ sendToQueue: mockSendToQueue });

    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: 2, name: 'USB-C Hub', price: 34.99, quantity: 3 }],
        totalAmount: 104.97,
      });

    expect(res.statusCode).toBe(201);
    expect(mockSendToQueue).toHaveBeenCalledWith(
      'order_placed',
      expect.any(Buffer),
      { persistent: true }
    );
  });

  it('still creates the order and returns 201 even if RabbitMQ is unavailable', async () => {
    getChannel.mockReturnValue(null);

    const res = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: 2, name: 'USB-C Hub', price: 34.99, quantity: 3 }],
        totalAmount: 104.97,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeDefined();

    const dbCheck = await pool.query('SELECT * FROM orders WHERE id = $1', [res.body.id]);
    expect(dbCheck.rows.length).toBe(1);
  });
});