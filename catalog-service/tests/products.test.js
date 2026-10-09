jest.mock('../src/middleware/auth0', () => {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const token = authHeader.replace('Bearer ', '');

    req.auth = {
      payload: {
        sub: 'test-user',
        permissions:
          token === 'test-customer-token'
            ? ['read:products']
            : ['read:products', 'write:products'],
      },
    };

    next();
  };
});

const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db');
const esClient = require('../src/es');

require('dotenv').config();

const token = 'test-admin-token';
const customerToken = 'test-customer-token';

describe('POST /products', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM products');

    await esClient
      .deleteByQuery({
        index: 'products_test',
        query: { match_all: {} },
        refresh: true,
      })
      .catch(() => {});
  });

  it('rejects requests with no token with 401', async () => {
    const res = await request(app)
      .post('/products')
      .send({
        name: 'Wireless Headphones',
        price: 149.99,
      });

    expect(res.statusCode).toBe(401);
  });

  it('rejects requests from a non-admin user with 403', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        name: 'Wireless Headphones',
        price: 149.99,
      });

    expect(res.statusCode).toBe(403);
  });

  it('creates a product in Postgres and indexes it in Elasticsearch', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Wireless Headphones',
        description: 'Noise-cancelling over-ear headphones',
        price: 149.99,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Wireless Headphones');
    expect(res.body.description).toBe(
      'Noise-cancelling over-ear headphones'
    );
    expect(Number(res.body.price)).toBe(149.99);

    const dbResult = await pool.query(
      'SELECT * FROM products WHERE id = $1',
      [res.body.id]
    );

    expect(dbResult.rows.length).toBe(1);
    expect(dbResult.rows[0].name).toBe('Wireless Headphones');
    expect(Number(dbResult.rows[0].price)).toBe(149.99);

    const esResult = await esClient.get({
      index: 'products_test',
      id: String(res.body.id),
    });

    expect(esResult._source.name).toBe('Wireless Headphones');
    expect(esResult._source.description).toBe(
      'Noise-cancelling over-ear headphones'
    );
    expect(Number(esResult._source.price)).toBe(149.99);
    expect(esResult._source.stock).toBeUndefined();
  });

  it('rejects a product with negative price', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Invalid Price Product',
        price: -10,
      });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a product with a non-numeric price', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Invalid Price Type Product',
        price: '10',
      });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a product with missing required fields with 400', async () => {
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        description: 'Missing name and price',
      });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /products/:id', () => {
  let productId;

  beforeEach(async () => {
    const result = await pool.query(
      `INSERT INTO products
       (name, description, price)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [
        'Test Product',
        'Product for testing',
        100,
      ]
    );

    productId = result.rows[0].id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM products');
  });

  it('returns the product for a valid ID', async () => {
    const res = await request(app)
      .get(`/products/${productId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(productId);
    expect(res.body.name).toBe('Test Product');
    expect(res.body.description).toBe('Product for testing');
    expect(Number(res.body.price)).toBe(100);
    expect(res.body.stock).toBeUndefined();
  });

  it('returns 404 for a non-existent ID', async () => {
    const res = await request(app)
      .get('/products/999999')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /products/search', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM products');

    await esClient
      .deleteByQuery({
        index: 'products_test',
        query: { match_all: {} },
        refresh: true,
      })
      .catch(() => {});
  });

  it('finds a product by exact name match', async () => {
    const product = await pool.query(
      `INSERT INTO products
       (name, description, price)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [
        'Wireless Headphones',
        'Noise cancelling headphones',
        149.99,
      ]
    );

    const createdProduct = product.rows[0];

    await esClient.index({
      index: 'products_test',
      id: String(createdProduct.id),
      document: {
        name: createdProduct.name,
        description: createdProduct.description,
        price: createdProduct.price,
      },
      refresh: true,
    });

    const res = await request(app)
      .get('/products/search')
      .query({ q: 'Wireless Headphones' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].name).toBe('Wireless Headphones');
    expect(res.body[0].description).toBe(
      'Noise cancelling headphones'
    );
    expect(res.body[0].stock).toBeUndefined();
  });

  it('finds a product despite a typo', async () => {
    const product = await pool.query(
      `INSERT INTO products
       (name, description, price)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [
        'Wireless Headphones',
        'Noise cancelling headphones',
        149.99,
      ]
    );

    const createdProduct = product.rows[0];

    await esClient.index({
      index: 'products_test',
      id: String(createdProduct.id),
      document: {
        name: createdProduct.name,
        description: createdProduct.description,
        price: createdProduct.price,
      },
      refresh: true,
    });

    const res = await request(app)
      .get('/products/search')
      .query({ q: 'Wireles Headpones' })
      .set('Authorization', 'Bearer ' + token);

    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].name).toBe('Wireless Headphones');
    expect(res.body[0].stock).toBeUndefined();
  });

  it('returns 400 when the search query is missing', async () => {
    const res = await request(app)
      .get('/products/search')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(400);
  });
});