const express = require('express');
const pool = require('./db');
const esClient = require('./es');

const app = express();
app.use(express.json());

const PRODUCTS_INDEX = process.env.NODE_ENV === 'test' ? 'products_test' : 'products';

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/products', async (req, res) => {
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

    res.status(201).json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = app;