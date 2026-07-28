const express = require('express');
const { client } = require('./redisClient');
const catalogClient = require('./catalogClient');
const authenticateToken = require('./middleware/auth');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/cart/items', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const { productId, quantity } = req.body;

  if (!productId || !quantity) {
    return res.status(400).json({ error: 'productId and quantity are required' });
  }

  let product;
  try {
    product = await catalogClient.getProduct(productId);
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({ error: 'Product not found' });
    }
    console.error('Failed to reach catalog-service:', err.message);
    return res.status(503).json({ error: 'Catalog service unavailable' });
  }

  const cartKey = `cart:${userId}`;
  const existingCartJson = await client.get(cartKey);
  const cart = existingCartJson ? JSON.parse(existingCartJson) : { items: [] };

  cart.items.push({
    productId: product.id,
    name: product.name,
    price: product.price,
    quantity,
  });

  await client.set(cartKey, JSON.stringify(cart));

  res.status(201).json(cart);
});

app.get('/cart', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const cartKey = `cart:${userId}`;

  const cartJson = await client.get(cartKey);
  const cart = cartJson ? JSON.parse(cartJson) : { items: [] };

  res.status(200).json(cart);
});

module.exports = app;