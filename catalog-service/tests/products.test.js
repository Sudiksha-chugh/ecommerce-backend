const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db');
const esClient = require('../src/es');
const jwt = require('jsonwebtoken');
require('dotenv').config();

function makeToken(userId, role = 'admin') {
  return jwt.sign(
    {
      userId,
      email: `${userId}@example.com`,
      role,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

const internalServiceKey = process.env.INTERNAL_SERVICE_KEY;

describe('POST /products', () => {
  const token = makeToken(1);
  const customerToken = makeToken(2, 'customer');

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
        stock: 25,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Wireless Headphones');

    const dbResult = await pool.query(
      'SELECT * FROM products WHERE id = $1',
      [res.body.id]
    );

    expect(dbResult.rows.length).toBe(1);

    const esResult = await esClient.get({
      index: 'products_test',
      id: String(res.body.id),
    });

    expect(esResult._source.name).toBe('Wireless Headphones');
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
  const token = makeToken(1);
  let productId;

  beforeEach(async () => {
    const result = await pool.query(
      `INSERT INTO products
       (name, description, price, stock)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        'Test Product',
        'Product for testing',
        100,
        10,
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
       (name, description, price, stock)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        'Wireless Headphones',
        'Noise cancelling headphones',
        149.99,
        20,
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
        stock: createdProduct.stock,
      },
      refresh: true,
    });

    const res = await request(app)
      .get('/products/search')
      .query({ q: 'Wireless Headphones' });

    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].name).toBe('Wireless Headphones');
  });

  it('finds a product despite a typo', async () => {
    const product = await pool.query(
      `INSERT INTO products
       (name, description, price, stock)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        'Wireless Headphones',
        'Noise cancelling headphones',
        149.99,
        20,
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
        stock: createdProduct.stock,
      },
      refresh: true,
    });

    const res = await request(app)
      .get('/products/search')
      .query({ q: 'Wireles Headpones' });

    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].name).toBe('Wireless Headphones');
  });
});

describe('POST /products/decrement-stock', () => {
  const token = makeToken(1);

  let productId;

  beforeEach(async () => {
    const result = await pool.query(
      `INSERT INTO products
       (name, description, price, stock)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        'Stock Test Product',
        'Product for stock testing',
        100,
        10,
      ]
    );

    productId = result.rows[0].id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM products');
  });

  it('decrements product stock by the requested quantity', async () => {
    const res = await request(app)
      .post('/products/decrement-stock')
      .set('Authorization', `Bearer ${token}`)
      .set('x-internal-service-key', internalServiceKey)
      .send({
        items: [
          {
            productId,
            quantity: 3,
          },
        ],
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.updated).toHaveLength(1);
    expect(res.body.updated[0].stock).toBe(7);

    const dbResult = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    expect(dbResult.rows[0].stock).toBe(7);
  });

  it('rejects the decrement when there is insufficient stock', async () => {
    const res = await request(app)
      .post('/products/decrement-stock')
      .set('Authorization', `Bearer ${token}`)
      .set('x-internal-service-key', internalServiceKey)
      .send({
        items: [
          {
            productId,
            quantity: 11,
          },
        ],
      });

    expect(res.statusCode).toBe(409);

    const dbResult = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    expect(dbResult.rows[0].stock).toBe(10);
  });

  it('rejects a negative quantity', async () => {
    const res = await request(app)
      .post('/products/decrement-stock')
      .set('Authorization', `Bearer ${token}`)
      .set('x-internal-service-key', internalServiceKey)
      .send({
        items: [
          {
            productId,
            quantity: -3,
          },
        ],
      });

    expect(res.statusCode).toBe(400);

    const dbResult = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    expect(dbResult.rows[0].stock).toBe(10);
  });

  it('rolls back all stock changes if any item has insufficient stock', async () => {
    const productA = await pool.query(
      `INSERT INTO products
       (name, description, price, stock)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        'Product A',
        'Test product A',
        100,
        10,
      ]
    );

    const productB = await pool.query(
      `INSERT INTO products
       (name, description, price, stock)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        'Product B',
        'Test product B',
        200,
        2,
      ]
    );

    const productAId = productA.rows[0].id;
    const productBId = productB.rows[0].id;

    const res = await request(app)
      .post('/products/decrement-stock')
      .set('Authorization', `Bearer ${token}`)
      .set('x-internal-service-key', internalServiceKey)
      .send({
        items: [
          {
            productId: productAId,
            quantity: 3,
          },
          {
            productId: productBId,
            quantity: 3,
          },
        ],
      });

    expect(res.statusCode).toBe(409);

    const result = await pool.query(
      `SELECT id, stock
       FROM products
       WHERE id IN ($1, $2)
       ORDER BY id`,
      [productAId, productBId]
    );

    expect(result.rows).toHaveLength(2);

    expect(result.rows[0].stock).toBe(10);
    expect(result.rows[1].stock).toBe(2);
  });
});

describe('POST /products/restore-stock', () => {
  const token = makeToken(1);

  let productId;

  beforeEach(async () => {
    const result = await pool.query(
      `INSERT INTO products
       (name, description, price, stock)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        'Restore Test Product',
        'Product for restore testing',
        100,
        7,
      ]
    );

    productId = result.rows[0].id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM products');
  });

  it('rejects a negative quantity', async () => {
    const res = await request(app)
      .post('/products/restore-stock')
      .set('Authorization', `Bearer ${token}`)
      .set('x-internal-service-key', internalServiceKey)
      .send({
        items: [
          {
            productId,
            quantity: -3,
          },
        ],
      });

    expect(res.statusCode).toBe(400);

    const dbResult = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    expect(dbResult.rows[0].stock).toBe(7);
  });

  it('rejects restoring stock for a product that does not exist', async () => {
    const res = await request(app)
      .post('/products/restore-stock')
      .set('Authorization', `Bearer ${token}`)
      .set('x-internal-service-key', internalServiceKey)
      .send({
        items: [
          {
            productId: 999999,
            quantity: 3,
          },
        ],
      });

    expect(res.statusCode).toBe(404);
  });

  it('rolls back all restores if one product does not exist', async () => {
    const productA = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Restore Product A',
        description: 'Atomic restore test A',
        price: 100,
        stock: 10,
      });

    const productB = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Restore Product B',
        description: 'Atomic restore test B',
        price: 200,
        stock: 5,
      });

    const productAId = productA.body.id;
    const productBId = productB.body.id;

    const res = await request(app)
      .post('/products/restore-stock')
      .set('Authorization', `Bearer ${token}`)
      .set('x-internal-service-key', internalServiceKey)
      .send({
        items: [
          {
            productId: productAId,
            quantity: 3,
          },
          {
            productId: 999999,
            quantity: 3,
          },
        ],
      });

    expect(res.statusCode).toBe(404);

    const resultA = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productAId]
    );

    expect(resultA.rows[0].stock).toBe(10);

    const resultB = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productBId]
    );

    expect(resultB.rows[0].stock).toBe(5);
  });

  it('restores product stock by the requested quantity', async () => {
    const res = await request(app)
      .post('/products/restore-stock')
      .set('Authorization', `Bearer ${token}`)
      .set('x-internal-service-key', internalServiceKey)
      .send({
        items: [
          {
            productId,
            quantity: 3,
          },
        ],
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.updated).toHaveLength(1);
    expect(res.body.updated[0].stock).toBe(10);

    const dbResult = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    expect(dbResult.rows[0].stock).toBe(10);
  });
});

afterAll(async () => {
  await pool.end();
});
describe('POST /products/reserve-stock', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM inventory_reservations');
    await pool.query('DELETE FROM products');
  });

  it('reserves stock and creates an inventory reservation', async () => {
    const product = await pool.query(
      `INSERT INTO products (name, price, stock)
       VALUES ($1, $2, $3)
       RETURNING *`,
      ['Test Product', 10.00, 5]
    );

    const productId = product.rows[0].id;

    const res = await request(app)
      .post('/products/reserve-stock')
      .set('x-internal-service-key', internalServiceKey)
      .send({
        orderId: 101,
        items: [
          {
            productId,
            quantity: 2,
          },
        ],
      });

    expect(res.statusCode).toBe(200);

    const stockResult = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    expect(stockResult.rows[0].stock).toBe(3);

    const reservationResult = await pool.query(
      `SELECT order_id, product_id, quantity, status
       FROM inventory_reservations
       WHERE order_id = $1`,
      [101]
    );

    expect(reservationResult.rows).toHaveLength(1);
    expect(reservationResult.rows[0]).toMatchObject({
      order_id: 101,
      product_id: productId,
      quantity: 2,
      status: 'reserved',
    });
  });
  it('is idempotent when the same order reserves the same product twice', async () => {
  const product = await pool.query(
    `INSERT INTO products (name, price, stock)
     VALUES ($1, $2, $3)
     RETURNING *`,
    ['Idempotency Product', 10.00, 5]
  );

  const productId = product.rows[0].id;

  const payload = {
    orderId: 103,
    items: [
      {
        productId,
        quantity: 2,
      },
    ],
  };

  const firstRes = await request(app)
    .post('/products/reserve-stock')
    .set('x-internal-service-key', internalServiceKey)
    .send(payload);

  const secondRes = await request(app)
    .post('/products/reserve-stock')
    .set('x-internal-service-key', internalServiceKey)
    .send(payload);

  expect(firstRes.statusCode).toBe(200);
  expect(secondRes.statusCode).toBe(200);

  const stockResult = await pool.query(
    'SELECT stock FROM products WHERE id = $1',
    [productId]
  );

  expect(stockResult.rows[0].stock).toBe(3);

  const reservationResult = await pool.query(
    `SELECT order_id, product_id, quantity, status
     FROM inventory_reservations
     WHERE order_id = $1`,
    [103]
  );

  expect(reservationResult.rows).toHaveLength(1);
  expect(reservationResult.rows[0]).toMatchObject({
    order_id: 103,
    product_id: productId,
    quantity: 2,
    status: 'reserved',
  });
});
it('is idempotent when duplicate reservation requests arrive concurrently', async () => {
  const product = await pool.query(
    `INSERT INTO products (name, price, stock)
     VALUES ($1, $2, $3)
     RETURNING *`,
    ['Concurrent Idempotency Product', 10.00, 5]
  );

  const productId = product.rows[0].id;

  const payload = {
    orderId: 104,
    items: [
      {
        productId,
        quantity: 2,
      },
    ],
  };

  const [firstRes, secondRes] = await Promise.all([
    request(app)
      .post('/products/reserve-stock')
      .set('x-internal-service-key', internalServiceKey)
      .send(payload),

    request(app)
      .post('/products/reserve-stock')
      .set('x-internal-service-key', internalServiceKey)
      .send(payload),
  ]);

  expect([firstRes.statusCode, secondRes.statusCode].sort()).toEqual([
    200,
    200,
  ]);

  const stockResult = await pool.query(
    'SELECT stock FROM products WHERE id = $1',
    [productId]
  );

  expect(stockResult.rows[0].stock).toBe(3);

  const reservationResult = await pool.query(
    `SELECT order_id, product_id, quantity, status
     FROM inventory_reservations
     WHERE order_id = $1`,
    [104]
  );

  expect(reservationResult.rows).toHaveLength(1);
  expect(reservationResult.rows[0]).toMatchObject({
    order_id: 104,
    product_id: productId,
    quantity: 2,
    status: 'reserved',
  });
});
  it('rolls back the reservation when there is insufficient stock', async () => {
  const product = await pool.query(
    `INSERT INTO products (name, price, stock)
     VALUES ($1, $2, $3)
     RETURNING *`,
    ['Limited Product', 10.00, 2]
  );

  const productId = product.rows[0].id;

  const res = await request(app)
    .post('/products/reserve-stock')
    .set('x-internal-service-key', internalServiceKey)
    .send({
      orderId: 102,
      items: [
        {
          productId,
          quantity: 3,
        },
      ],
    });

  expect(res.statusCode).toBe(409);

  const stockResult = await pool.query(
    'SELECT stock FROM products WHERE id = $1',
    [productId]
  );

  expect(stockResult.rows[0].stock).toBe(2);

  const reservationResult = await pool.query(
    `SELECT *
     FROM inventory_reservations
     WHERE order_id = $1`,
    [102]
  );

  expect(reservationResult.rows).toHaveLength(0);
});
it('allows only one order to reserve the last available unit', async () => {
  const product = await pool.query(
    `INSERT INTO products (name, price, stock)
     VALUES ($1, $2, $3)
     RETURNING *`,
    ['Last Unit Product', 10.00, 1]
  );

  const productId = product.rows[0].id;

  const [res1, res2] = await Promise.all([
    request(app)
      .post('/products/reserve-stock')
      .set('x-internal-service-key', internalServiceKey)
      .send({
        orderId: 201,
        items: [{ productId, quantity: 1 }],
      }),

    request(app)
      .post('/products/reserve-stock')
      .set('x-internal-service-key', internalServiceKey)
      .send({
        orderId: 202,
        items: [{ productId, quantity: 1 }],
      }),
  ]);

  const statuses = [res1.statusCode, res2.statusCode].sort();

  expect(statuses).toEqual([200, 409]);

  const stockResult = await pool.query(
    'SELECT stock FROM products WHERE id = $1',
    [productId]
  );

  expect(stockResult.rows[0].stock).toBe(0);

  const reservations = await pool.query(
    `SELECT order_id, quantity
     FROM inventory_reservations
     WHERE product_id = $1`,
    [productId]
  );

  expect(reservations.rows).toHaveLength(1);
  expect(reservations.rows[0].quantity).toBe(1);
});
describe('POST /products/confirm-reservation', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM inventory_reservations');
    await pool.query('DELETE FROM products');
  });

  it('confirms a reserved inventory reservation', async () => {
    const product = await pool.query(
      `INSERT INTO products (name, price, stock)
       VALUES ($1, $2, $3)
       RETURNING *`,
      ['Confirm Product', 10.00, 5]
    );

    const productId = product.rows[0].id;

    await pool.query(
      `INSERT INTO inventory_reservations
        (order_id, product_id, quantity, status)
       VALUES ($1, $2, $3, 'reserved')`,
      [301, productId, 2]
    );

    const res = await request(app)
      .post('/products/confirm-reservation')
      .set('x-internal-service-key', internalServiceKey)
      .send({
        orderId: 301,
      });

    expect(res.statusCode).toBe(200);

    const reservation = await pool.query(
      `SELECT status
       FROM inventory_reservations
       WHERE order_id = $1`,
      [301]
    );

    expect(reservation.rows).toHaveLength(1);
    expect(reservation.rows[0].status).toBe('confirmed');

    const stockResult = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    // Confirming does NOT add stock back.
    expect(stockResult.rows[0].stock).toBe(5);
  });
});
describe('POST /products/release-reservation', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM inventory_reservations');
    await pool.query('DELETE FROM products');
  });

  it('releases a reserved inventory reservation and restores stock', async () => {
    const product = await pool.query(
      `INSERT INTO products (name, price, stock)
       VALUES ($1, $2, $3)
       RETURNING *`,
      ['Release Product', 10.00, 3]
    );

    const productId = product.rows[0].id;

    await pool.query(
      `INSERT INTO inventory_reservations
        (order_id, product_id, quantity, status)
       VALUES ($1, $2, $3, 'reserved')`,
      [401, productId, 2]
    );

    const res = await request(app)
      .post('/products/release-reservation')
      .set('x-internal-service-key', internalServiceKey)
      .send({
        orderId: 401,
      });

    expect(res.statusCode).toBe(200);

    const reservation = await pool.query(
      `SELECT status
       FROM inventory_reservations
       WHERE order_id = $1`,
      [401]
    );

    expect(reservation.rows).toHaveLength(1);
    expect(reservation.rows[0].status).toBe('released');

    const stockResult = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    expect(stockResult.rows[0].stock).toBe(5);
  });
});
});