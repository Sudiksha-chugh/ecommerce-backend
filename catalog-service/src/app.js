const express = require('express');
const pool = require('./db');
const esClient = require('./es');
const logger = require('./logger');

const app = express();
app.use(express.json());

const PRODUCTS_INDEX = process.env.NODE_ENV === 'test' ? 'products_test' : 'products';

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const authenticateToken = require('./middleware/auth');

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
app.post('/products', authenticateToken, requireAdmin, async (req, res) => {
  const { name, description, price, stock } = req.body;

  if (!name || price === undefined) {
    return res.status(400).json({ error: 'Name and price are required' });
  }

  try {
    const dbResult = await pool.query(
      'INSERT INTO products (name, description, price, stock) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description || null, price, stock || 0]
    );

    const product = dbResult.rows[0];

    await esClient.index({
      index: PRODUCTS_INDEX,
      id: String(product.id),
      document: {
        name: product.name,
        description: product.description,
        price: product.price,
        stock: product.stock,
      },
      refresh: true,
    });
    logger.info('Product created', { productId: product.id, name: product.name, createdBy: req.user.userId });
    res.status(201).json(product);
  } catch (err) {
    logger.error('Product creation failed', { error: err.message, name });
    res.status(500).json({ error: 'Something went wrong' });
  }
});
app.get('/products/search', async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
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
    res.status(200).json(products);
  } catch (err) {
    logger.error('Product search failed', { error: err.message, query: q });
    res.status(500).json({ error: 'Something went wrong' });
  }
});
app.get('/products/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
        res.status(200).json(result.rows[0]);
  } catch (err) {
    logger.error('Product lookup failed', { error: err.message, productId: req.params.id });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/products/decrement-stock', authenticateToken, async (req, res) => {
  const { items } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const updatedProducts = [];

    for (const item of items) {
      if (!item.productId || !Number.isInteger(item.quantity) || item.quantity <= 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error: 'productId and a positive integer quantity are required',
        });
      }

      const result = await client.query(
        `UPDATE products
         SET stock = stock - $1
         WHERE id = $2 AND stock >= $1
         RETURNING *`,
        [item.quantity, item.productId]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');

        logger.warn('Stock decrement failed: insufficient stock', {
          productId: item.productId,
          requestedQuantity: item.quantity,
        });

        return res.status(409).json({
          error: `Insufficient stock for product ${item.productId}`,
          productId: item.productId,
        });
      }

      updatedProducts.push(result.rows[0]);
    }

    await client.query('COMMIT');

    for (const product of updatedProducts) {
      await esClient.index({
        index: PRODUCTS_INDEX,
        id: String(product.id),
        document: {
          name: product.name,
          description: product.description,
          price: product.price,
          stock: product.stock,
        },
        refresh: true,
      }).catch((esErr) => {
        logger.error('Failed to sync stock update to Elasticsearch', {
          error: esErr.message,
          productId: product.id,
        });
      });
    }

    logger.info('Stock decremented for order', { items });

    res.status(200).json({ updated: updatedProducts });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    logger.error('Stock decrement failed', {
      error: err.message,
      items,
    });

    res.status(500).json({ error: 'Failed to decrement stock' });
  } finally {
    client.release();
  }
});
app.post('/products/restore-stock', authenticateToken, async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      error: 'items must be a non-empty array',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const updatedProducts = [];

    for (const item of items) {
      // Validate productId and quantity
      if (
        !item.productId ||
        !Number.isInteger(item.quantity) ||
        item.quantity <= 0
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error: 'productId and a positive integer quantity are required',
        });
      }

      // Restore stock
      const result = await client.query(
        `UPDATE products
         SET stock = stock + $1
         WHERE id = $2
         RETURNING *`,
        [item.quantity, item.productId]
      );

      // Product does not exist
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: `Product ${item.productId} not found`,
        });
      }

      updatedProducts.push(result.rows[0]);
    }

    await client.query('COMMIT');

    // Sync updated products to Elasticsearch
    for (const product of updatedProducts) {
      await esClient.index({
        index: PRODUCTS_INDEX,
        id: product.id.toString(),
        document: product,
      });
    }

    logger.info({
      message: 'Stock restored',
      items,
    });

    return res.status(200).json({
      message: 'Stock restored successfully',
      updated: updatedProducts,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    logger.error({
      message: 'Failed to restore stock',
      error: error.message,
    });

    return res.status(500).json({
      error: 'Failed to restore stock',
    });
  } finally {
    client.release();
  }
});
module.exports = app;