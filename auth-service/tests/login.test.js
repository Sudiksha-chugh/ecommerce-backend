const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const pool = require('../src/db');
const logger = require('../src/logger');

describe('POST /login', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info');
    jest.spyOn(logger, 'warn');
    jest.spyOn(logger, 'error');
  });

  beforeEach(async () => {
    await request(app)
      .post('/register')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await pool.query('DELETE FROM users');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('logs in with correct credentials and returns access and refresh tokens', async () => {
    const res = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  it('writes an audit log for successful login', async () => {
    await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    expect(logger.info).toHaveBeenCalledWith(
      'User logged in',
      expect.objectContaining({
        event: 'auth.login.success',
        email: 'logintest@example.com',
        role: 'customer',
      })
    );
  });

  it('writes an audit log for failed login', async () => {
    await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'wrongPassword' });

    expect(logger.warn).toHaveBeenCalledWith(
      'Login failed: invalid password',
      expect.objectContaining({
        event: 'auth.login.failed',
        reason: 'invalid_password',
        email: 'logintest@example.com',
      })
    );
  });

  it('writes an audit log for successful refresh', async () => {
    const loginRes = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    await request(app)
      .post('/refresh')
      .send({ refreshToken: loginRes.body.refreshToken });

    expect(logger.info).toHaveBeenCalledWith(
      'Refresh token rotated',
      expect.objectContaining({
        event: 'auth.refresh.success',
        role: 'customer',
      })
    );
  });

  it('writes an audit log for failed refresh with an invalid token', async () => {
    await request(app)
      .post('/refresh')
      .send({ refreshToken: 'invalid-refresh-token' });

    expect(logger.warn).toHaveBeenCalledWith(
      'Refresh failed: invalid token',
      expect.objectContaining({
        event: 'auth.refresh.failed',
        reason: 'invalid_token',
      })
    );
  });

  it('writes an audit log for refresh token reuse', async () => {
    const loginRes = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    const oldRefreshToken = loginRes.body.refreshToken;

    await request(app)
      .post('/refresh')
      .send({ refreshToken: oldRefreshToken });

    await request(app)
      .post('/refresh')
      .send({ refreshToken: oldRefreshToken });

    expect(logger.warn).toHaveBeenCalledWith(
      'Refresh failed: revoked token reuse',
      expect.objectContaining({
        event: 'auth.refresh.failed',
        reason: 'revoked_token',
      })
    );
  });

  it('writes an audit log for failed logout when the refresh token is missing', async () => {
    await request(app)
      .post('/logout')
      .send({});

    expect(logger.warn).toHaveBeenCalledWith(
      'Logout failed: refresh token missing',
      expect.objectContaining({
        event: 'auth.logout.failed',
        reason: 'refresh_token_missing',
      })
    );
  });

  it('writes an audit log for failed logout with an invalid token', async () => {
    await request(app)
      .post('/logout')
      .send({ refreshToken: 'invalid-refresh-token' });

    expect(logger.warn).toHaveBeenCalledWith(
      'Logout failed: invalid or already revoked token',
      expect.objectContaining({
        event: 'auth.logout.failed',
        reason: 'invalid_or_revoked_token',
      })
    );
  });

  it('writes an audit log for successful logout', async () => {
    const loginRes = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    await request(app)
      .post('/logout')
      .send({ refreshToken: loginRes.body.refreshToken });

    expect(logger.info).toHaveBeenCalledWith(
      'User logged out',
      expect.objectContaining({
        event: 'auth.logout.success',
      })
    );
  });

  it('includes the role in the JWT payload', async () => {
    const res = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    const decoded = jwt.decode(res.body.token);
    expect(decoded.role).toBe('customer');
  });

  it('refreshes a valid refresh token and returns new tokens', async () => {
    const loginRes = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    const refreshRes = await request(app)
      .post('/refresh')
      .send({ refreshToken: loginRes.body.refreshToken });

    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.body.token).toBeDefined();
    expect(refreshRes.body.refreshToken).toBeDefined();
    expect(refreshRes.body.refreshToken).not.toBe(loginRes.body.refreshToken);
  });

  it('rejects reuse of an old refresh token after rotation', async () => {
    const loginRes = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    const oldRefreshToken = loginRes.body.refreshToken;

    const refreshRes = await request(app)
      .post('/refresh')
      .send({ refreshToken: oldRefreshToken });

    expect(refreshRes.statusCode).toBe(200);

    const reusedRes = await request(app)
      .post('/refresh')
      .send({ refreshToken: oldRefreshToken });

    expect(reusedRes.statusCode).toBe(401);
  });

  it('rejects login with wrong password with 401', async () => {
    const res = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'wrongPassword' });

    expect(res.statusCode).toBe(401);
  });

  it('rejects login for a non-existent email with 401', async () => {
    const res = await request(app)
      .post('/login')
      .send({ email: 'ghost@example.com', password: 'whatever' });

    expect(res.statusCode).toBe(401);
  });

  it('logs out successfully and revokes the refresh token', async () => {
    const loginRes = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    const logoutRes = await request(app)
      .post('/logout')
      .send({ refreshToken: loginRes.body.refreshToken });

    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.body.message).toBe('Logged out successfully');

    const refreshRes = await request(app)
      .post('/refresh')
      .send({ refreshToken: loginRes.body.refreshToken });

    expect(refreshRes.statusCode).toBe(401);
    expect(refreshRes.body.error).toBe('Refresh token has been revoked');
  });

  it('rejects logout when the refresh token is missing', async () => {
    const res = await request(app)
      .post('/logout')
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Refresh token is required');
  });

  it('rejects logout when the refresh token is invalid', async () => {
    const res = await request(app)
      .post('/logout')
      .send({ refreshToken: 'invalid-refresh-token' });

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid refresh token');
  });

  it('rejects logout when the refresh token was already revoked', async () => {
    const loginRes = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    const firstLogoutRes = await request(app)
      .post('/logout')
      .send({ refreshToken: loginRes.body.refreshToken });

    expect(firstLogoutRes.statusCode).toBe(200);

    const secondLogoutRes = await request(app)
      .post('/logout')
      .send({ refreshToken: loginRes.body.refreshToken });

    expect(secondLogoutRes.statusCode).toBe(401);
    expect(secondLogoutRes.body.error).toBe('Invalid refresh token');
  });
});
