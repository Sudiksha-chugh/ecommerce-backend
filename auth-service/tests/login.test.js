const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const pool = require('../src/db');

describe('POST /login', () => {
  beforeEach(async () => {
    await request(app)
      .post('/register')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });
  });

  afterEach(async () => {
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
});