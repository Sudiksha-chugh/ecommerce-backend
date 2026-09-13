const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const authenticateToken = require('./middleware/auth');
const logger = require('./logger');
const requestIdMiddleware = require('./requestId');
const crypto = require('crypto');

const REFRESH_TOKEN_BYTES = 32;

function generateRefreshToken() {
  return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role, created_at',
      [email, passwordHash]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
      logger.error('Registration failed', {
        error: err.message,
        email,
        requestId: req.requestId,
      });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, role FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      logger.warn('Login failed: user not found', {
        event: 'auth.login.failed',
        reason: 'user_not_found',
        email,
        requestId: req.requestId,
      });

      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      logger.warn('Login failed: invalid password', {
        event: 'auth.login.failed',
        reason: 'invalid_password',
        email,
        requestId: req.requestId,
      });

      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '15m', algorithm: 'HS256' }
    );

    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const refreshTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshTokenHash, refreshTokenExpiresAt]
    );

    logger.info('User logged in', {
      event: 'auth.login.success',
      userId: user.id,
      email: user.email,
      role: user.role,
      requestId: req.requestId,
    });
    res.status(200).json({ token, refreshToken });
  } catch (err) {
      logger.error('Login failed', {
        error: err.message,
        email,
        requestId: req.requestId,
      });
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token is required' });
  }

  const refreshTokenHash = hashRefreshToken(refreshToken);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [refreshTokenHash]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');

      logger.warn('Refresh failed: invalid token', {
        event: 'auth.refresh.failed',
        reason: 'invalid_token',
        requestId: req.requestId,
      });

      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const storedToken = result.rows[0];

    if (storedToken.revoked_at) {
      await client.query('ROLLBACK');

      logger.warn('Refresh failed: revoked token reuse', {
        event: 'auth.refresh.failed',
        reason: 'revoked_token',
        requestId: req.requestId,
      });

      return res.status(401).json({ error: 'Refresh token has been revoked' });
    }

    if (new Date(storedToken.expires_at) <= new Date()) {
      await client.query('ROLLBACK');

      logger.warn('Refresh failed: expired token', {
        event: 'auth.refresh.failed',
        reason: 'expired_token',
        requestId: req.requestId,
      });

      return res.status(401).json({ error: 'Refresh token has expired' });
    }

    const userResult = await client.query(
      'SELECT id, email, role FROM users WHERE id = $1',
      [storedToken.user_id]
    );

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');

      logger.warn('Refresh failed: user not found', {
        event: 'auth.refresh.failed',
        reason: 'user_not_found',
        requestId: req.requestId,
      });

      return res.status(401).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '15m', algorithm: 'HS256' }
    );

    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashRefreshToken(newRefreshToken);
    const newRefreshTokenExpiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    );

    const newTokenResult = await client.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id',
      [user.id, newRefreshTokenHash, newRefreshTokenExpiresAt]
    );

    await client.query(
      'UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $1 WHERE id = $2',
      [newTokenResult.rows[0].id, storedToken.id]
    );

    await client.query('COMMIT');

    logger.info('Refresh token rotated', {
      event: 'auth.refresh.success',
      userId: user.id,
      role: user.role,
      requestId: req.requestId,
    });

    res.status(200).json({
      token,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Refresh token rollback failed', {
        error: rollbackErr.message,
        requestId: req.requestId,
      });
    }

    logger.error('Refresh token failed', {
      error: err.message,
      requestId: req.requestId,
    });
    res.status(500).json({ error: 'Something went wrong' });
  } finally {
    client.release();
  }
});

app.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    logger.warn('Logout failed: refresh token missing', {
      event: 'auth.logout.failed',
      reason: 'refresh_token_missing',
      requestId: req.requestId,
    });

    return res.status(400).json({ error: 'Refresh token is required' });
  }

  const refreshTokenHash = hashRefreshToken(refreshToken);

  try {
    const result = await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id',
      [refreshTokenHash]
    );

    if (result.rows.length === 0) {
      logger.warn('Logout failed: invalid or already revoked token', {
        event: 'auth.logout.failed',
        reason: 'invalid_or_revoked_token',
        requestId: req.requestId,
      });

      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    logger.info('User logged out', {
      event: 'auth.logout.success',
      userId: result.rows[0].user_id,
      requestId: req.requestId,
    });

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    logger.error('Logout failed', {
      event: 'auth.logout.error',
      error: err.message,
      requestId: req.requestId,
    });

    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/me', authenticateToken, (req, res) => {
  res.status(200).json(req.user);
});

module.exports = app;