jest.mock('../src/catalogClient');

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { client, connectRedis } = require('../src/redisClient');
const catalogClient = require('../src/catalogClient');
require('dotenv').config();

function makeToken(userId) {
  return jwt.sign({ userId, email: `${userId}@example.com` }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('POST /cart/items', () => {
  const token = makeToken('user1');

  afterEach(async () => {
    await client.del('cart:user1');
    jest.clearAllMocks();
  });

  it('rejects requests with no token with 401', async () => {
    const res = await request(app)
      .post('/cart/items')
      .send({ productId: 1, quantity: 1 });

    expect(res.statusCode).toBe(401);
  });

  it('adds an item to the cart for the authenticated user', async () => {
    catalogClient.getProduct.mockResolvedValue({
      id: 1,
      name: 'Wireless Headphones',
      price: '149.99',
      stock: 25,
    });

    const res = await request(app)
      .post('/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: 1, quantity: 2 });

    expect(res.statusCode).toBe(201);
    expect(res.body.items[0].name).toBe('Wireless Headphones');
  });

  it('returns 404 if the product does not exist in catalog-service', async () => {
    catalogClient.getProduct.mockRejectedValue({ response: { status: 404 } });

    const res = await request(app)
      .post('/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: 999, quantity: 1 });

    expect(res.statusCode).toBe(404);
  });

  it('returns 503 if catalog-service is unreachable', async () => {
    catalogClient.getProduct.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app)
      .post('/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: 1, quantity: 1 });

    expect(res.statusCode).toBe(503);
  });
});

describe('GET /cart', () => {
  const token = makeToken('user2');

  afterEach(async () => {
    await client.del('cart:user2');
  });

  it('rejects requests with no token with 401', async () => {
    const res = await request(app).get('/cart');
    expect(res.statusCode).toBe(401);
  });

  it('returns an empty cart for a user with no items', async () => {
    const res = await request(app)
      .get('/cart')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('returns the existing cart for a user with items', async () => {
    await client.set('cart:user2', JSON.stringify({ items: [{ productId: 1, name: 'Test', price: '10.00', quantity: 1 }] }));

    const res = await request(app)
      .get('/cart')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.items.length).toBe(1);
  });
});

beforeAll(async () => {
  await connectRedis();
});

afterAll(async () => {
  await client.quit();
});