const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
require('dotenv').config();

const app = express();

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/auth', createProxyMiddleware({
  target: process.env.AUTH_SERVICE_URL,
  changeOrigin: true,
}));

app.use('/products', createProxyMiddleware({
  target: process.env.CATALOG_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: (path) => '/products' + path,
}));

app.use('/cart', createProxyMiddleware({
  target: process.env.CART_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: (path) => '/cart' + path,
}));

app.use('/orders', createProxyMiddleware({
  target: process.env.ORDERS_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: (path) => '/orders' + path,
}));

module.exports = app;