const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
require('dotenv').config();

const app = express();

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

function proxyOptions(target, prefix) {
  return {
    target,
    changeOrigin: true,
    pathRewrite: prefix ? (path) => prefix + path : undefined,
    on: {
      error: (err, req, res) => {
        console.error(`Proxy error reaching ${target}:`, err.message);
        if (!res.headersSent) {
          res.status(503).json({ error: 'Upstream service unavailable' });
        }
      },
    },
  };
}

app.use('/auth', createProxyMiddleware(proxyOptions(process.env.AUTH_SERVICE_URL, null)));
app.use('/products', createProxyMiddleware(proxyOptions(process.env.CATALOG_SERVICE_URL, '/products')));
app.use('/cart', createProxyMiddleware(proxyOptions(process.env.CART_SERVICE_URL, '/cart')));
app.use('/orders', createProxyMiddleware(proxyOptions(process.env.ORDERS_SERVICE_URL, '/orders')));

module.exports = app;