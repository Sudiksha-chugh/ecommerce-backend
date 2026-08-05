const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later' },
});

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

app.use('/auth', authLimiter, createProxyMiddleware(proxyOptions(process.env.AUTH_SERVICE_URL, null)));
app.use('/products', generalLimiter, createProxyMiddleware(proxyOptions(process.env.CATALOG_SERVICE_URL, '/products')));
app.use('/cart', generalLimiter, createProxyMiddleware(proxyOptions(process.env.CART_SERVICE_URL, '/cart')));
app.use('/orders', generalLimiter, createProxyMiddleware(proxyOptions(process.env.ORDERS_SERVICE_URL, '/orders')));
module.exports = app;