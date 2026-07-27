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

  afterAll(async () => {
    await pool.end();
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