const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db');
const esClient = require('../src/es');

describe('POST /products', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM products');
    await esClient.deleteByQuery({
      index: 'products_test',
      query: { match_all: {} },
      refresh: true,
    }).catch(() => {});
  });
  it('creates a product in Postgres and indexes it in Elasticsearch', async () => {
    const res = await request(app)
      .post('/products')
      .send({
        name: 'Wireless Headphones',
        description: 'Noise-cancelling over-ear headphones',
        price: 149.99,
        stock: 25,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Wireless Headphones');

    // Confirm it actually landed in Postgres
    const dbResult = await pool.query('SELECT * FROM products WHERE id = $1', [res.body.id]);
    expect(dbResult.rows.length).toBe(1);

    // Confirm it actually landed in Elasticsearch too
    const esResult = await esClient.get({
      index: 'products_test',
      id: String(res.body.id),
    });
    expect(esResult._source.name).toBe('Wireless Headphones');
  });

  it('rejects a product with missing required fields with 400', async () => {
    const res = await request(app)
      .post('/products')
      .send({ description: 'Missing name and price' });

    expect(res.statusCode).toBe(400);
  });
});
describe('GET /products/:id', () => {
  let productId;

  beforeEach(async () => {
    const res = await request(app)
      .post('/products')
      .send({ name: 'Test Speaker', description: 'A speaker', price: 79.99, stock: 10 });
    productId = res.body.id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM products');
  });

  it('returns the product for a valid ID', async () => {
    const res = await request(app).get(`/products/${productId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe('Test Speaker');
  });

  it('returns 404 for a non-existent ID', async () => {
    const res = await request(app).get('/products/999999');
    expect(res.statusCode).toBe(404);
  });
});
describe('GET /products/search', () => {
  beforeEach(async () => {
    await request(app)
      .post('/products')
      .send({ name: 'Wireless Headphones', description: 'Noise-cancelling audio', price: 149.99, stock: 5 });
  });

  afterEach(async () => {
    await pool.query('DELETE FROM products');
  });

  it('finds a product by exact name match', async () => {
    const res = await request(app).get('/products/search?q=headphones');
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].name).toBe('Wireless Headphones');
  });

  it('finds a product despite a typo (fuzzy match)', async () => {
    const res = await request(app).get('/products/search?q=headphons');
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

  afterAll(async () => {
    await pool.end();
  });