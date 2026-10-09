const express = require('express');
const pool = require('./db');
const esClient = require('./es');
const logger = require('./logger');
const requestIdMiddleware = require('./requestId');

const app = express();

app.use(requestIdMiddleware);
app.use(express.json({ limit: '1mb' }));

const PRODUCTS_INDEX =
  process.env.NODE_ENV === 'test' ? 'products_test' : 'products';

const checkAuth0Token = require('./middleware/auth0');
const requirePermission = require('./middleware/requirePermission');

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post(
  '/products',
  checkAuth0Token,
  requirePermission('write:products'),
  async (req, res) => {
    const { name, description, price } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({
        error: 'Name and price are required',
      });
    }

    if (
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      return res.status(400).json({
        error: 'Price must be a non-negative number',
      });
    }

    try {
      const dbResult = await pool.query(
        `INSERT INTO products (name, description, price)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [name, description || null, price]
      );

      const product = dbResult.rows[0];

      await esClient.index({
        index: PRODUCTS_INDEX,
        id: String(product.id),
        document: {
          name: product.name,
          description: product.description,
          price: product.price,
        },
        refresh: true,
      });

      logger.info('Product created', {
        productId: product.id,
        name,
        createdBy: req.auth.payload.sub,
        requestId: req.requestId,
      });

      return res.status(201).json(product);
    } catch (err) {
      logger.error('Product creation failed', {
        error: err.message,
        name,
        requestId: req.requestId,
      });

      return res.status(500).json({
        error: 'Something went wrong',
      });
    }
  }
);

app.get(
  '/products/search',
  checkAuth0Token,
  requirePermission('read:products'),
  async (req, res) => {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({
        error: 'Query parameter "q" is required',
      });
    }

    try {
      const result = await esClient.search({
        index: PRODUCTS_INDEX,
        query: {
          multi_match: {
            query: q,
            fields: ['name', 'description'],
            fuzziness: 'AUTO',
          },
        },
      });

      const products = result.hits.hits.map((hit) => ({
        id: hit._id,
        score: hit._score,
        ...hit._source,
      }));

      return res.status(200).json(products);
    } catch (err) {
      logger.error('Product search failed', {
        error: err.message,
        query: q,
        requestId: req.requestId,
      });

      return res.status(500).json({
        error: 'Something went wrong',
      });
    }
  }
);

app.get(
  '/products/:id',
  checkAuth0Token,
  requirePermission('read:products'),
  async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM products WHERE id = $1',
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Product not found',
        });
      }

      return res.status(200).json(result.rows[0]);
    } catch (err) {
      logger.error('Product lookup failed', {
        error: err.message,
        productId: req.params.id,
        requestId: req.requestId,
      });

      return res.status(500).json({
        error: 'Something went wrong',
      });
    }
  }
);

module.exports = app;