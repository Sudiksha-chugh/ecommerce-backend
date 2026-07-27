jest.mock('../src/catalogClient');

const request = require('supertest');
const app = require('../src/app');
const { client, connectRedis } = require('../src/redisClient');
const catalogClient = require('../src/catalogClient');

describe('POST /cart/:userId/items', () => {

  afterEach(async () => {
    await client.del('cart:user1');
    jest.clearAllMocks();
  });

  it('adds an item to the cart after verifying it with catalog-service', async () => {
    catalogClient.getProduct.mockResolvedValue({
      id: 1,
      name: 'Wireless Headphones',
      price: '149.99',
      stock: 25,
    });

    const res = await request(app)
      .post('/cart/user1/items')
      .send({ productId: 1, quantity: 2 });

    expect(res.statusCode).toBe(201);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].name).toBe('Wireless Headphones');
    expect(res.body.items[0].quantity).toBe(2);
    expect(catalogClient.getProduct).toHaveBeenCalledWith(1);
  });

  it('returns 404 if the product does not exist in catalog-service', async () => {
    catalogClient.getProduct.mockRejectedValue({ response: { status: 404 } });

    const res = await request(app)
      .post('/cart/user1/items')
      .send({ productId: 999, quantity: 1 });

    expect(res.statusCode).toBe(404);
  });

  it('returns 503 if catalog-service is unreachable', async () => {
    catalogClient.getProduct.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app)
      .post('/cart/user1/items')
      .send({ productId: 1, quantity: 1 });

    expect(res.statusCode).toBe(503);
  });
});

describe('GET /cart/:userId', () => {
  afterEach(async () => {
    await client.del('cart:user2');
  });

  it('returns an empty cart for a user with no items', async () => {
    const res = await request(app).get('/cart/user2');
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('returns the existing cart for a user with items', async () => {
    await client.set('cart:user2', JSON.stringify({ items: [{ productId: 1, name: 'Test', price: '10.00', quantity: 1 }] }));

    const res = await request(app).get('/cart/user2');
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
