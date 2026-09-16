const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const logger = require('./logger');
const requestIdMiddleware = require('./requestId');
const crypto = require('crypto');
const cookie = require('cookie');
require('dotenv').config();

const app = express();

app.use(requestIdMiddleware);

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

app.get('/login', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');

  res.setHeader(
    'Set-Cookie',
    cookie.serialize('auth0_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 600,
      path: '/',
    })
  );

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.AUTH0_CLIENT_ID,
    redirect_uri: 'http://localhost:8080/callback',
    scope: 'openid profile email offline_access',
    audience: process.env.AUTH0_AUDIENCE,
    state,
  });

  res.redirect(
    `https://${process.env.AUTH0_DOMAIN}/authorize?${params.toString()}`
  );
});

app.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    const cookies = cookie.parse(req.headers.cookie || '');
    const savedState = cookies.auth0_state;

    if (!code || !state || !savedState || state !== savedState) {
      return res.status(400).json({
        error: 'Invalid authentication callback',
      });
    }

    const tokenResponse = await fetch(
      `https://${process.env.AUTH0_DOMAIN}/oauth/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: process.env.AUTH0_CLIENT_ID,
          client_secret: process.env.AUTH0_CLIENT_SECRET,
          code,
          redirect_uri: 'http://localhost:8080/callback',
        }),
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      logger.error('Auth0 token exchange failed', {
        status: tokenResponse.status,
        error: tokenData.error,
      });

      return res.status(401).json({
        error: 'Authentication failed',
      });
    }

    res.setHeader('Set-Cookie', [
      cookie.serialize('auth0_state', '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 0,
        path: '/',
      }),
      cookie.serialize('auth0_access_token', tokenData.access_token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: tokenData.expires_in,
        path: '/',
      }),
    ]);

    res.status(200).json({
      message: 'Login successful',
      token_type: tokenData.token_type,
      expires_in: tokenData.expires_in,
    });
  } catch (error) {
    logger.error('Auth0 callback failed', {
      error: error.message,
    });

    res.status(500).json({
      error: 'Authentication failed',
    });
  }
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
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-Request-ID', req.requestId);

        const cookies = cookie.parse(req.headers.cookie || '');
        const accessToken = cookies.auth0_access_token;

        if (accessToken) {
          proxyReq.setHeader('Authorization', `Bearer ${accessToken}`);
        }

        if (req.headers['idempotency-key']) {
          proxyReq.setHeader('Idempotency-Key', req.headers['idempotency-key']);
        }
      },

      error: (err, req, res) => {
        logger.error('Proxy error reaching upstream service', {
          target,
          error: err.message,
          path: req.originalUrl,
        });

        if (!res.headersSent) {
          res.status(503).json({ error: 'Upstream service unavailable' });
        }
      },
    },
  };
}

app.use(
  '/auth',
  authLimiter,
  createProxyMiddleware(proxyOptions(process.env.AUTH_SERVICE_URL, null))
);

app.use(
  '/products',
  generalLimiter,
  createProxyMiddleware(
    proxyOptions(process.env.CATALOG_SERVICE_URL, '/products')
  )
);

app.use(
  '/cart',
  generalLimiter,
  createProxyMiddleware(proxyOptions(process.env.CART_SERVICE_URL, '/cart'))
);

app.use(
  '/orders',
  generalLimiter,
  createProxyMiddleware(proxyOptions(process.env.ORDERS_SERVICE_URL, '/orders'))
);

module.exports = app;
