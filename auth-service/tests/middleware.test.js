const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db');
const jwt = require('jsonwebtoken');
require('dotenv').config();

describe('auth middleware', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('rejects requests with no token with 401', async () => {
    const res = await request(app).get('/me');
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with an invalid token with 401', async () => {
    const res = await request(app)
      .get('/me')
      .set('Authorization', 'Bearer garbage-token');
    expect(res.statusCode).toBe(401);
  });

  it('allows requests with a valid token and returns the user payload', async () => {
    const token = jwt.sign({ userId: 1, email: 'test@example.com' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.email).toBe('test@example.com');
  });
});