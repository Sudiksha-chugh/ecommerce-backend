const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db');
const jwt = require('jsonwebtoken');
require('dotenv').config();

process.env.INTERNAL_SERVICE_KEY = 'test-internal-service-key-123456789';

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

  it('rejects tokens signed with an unexpected algorithm with 401', async () => {
    const token = jwt.sign(
      { userId: 1, email: 'test@example.com' },
      process.env.JWT_CURRENT_SECRET,
      { expiresIn: '1h', algorithm: 'HS384' }
    );

    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(401);
  });

  it('allows requests with a valid HS256 token and returns the user payload', async () => {
    const token = jwt.sign(
      { userId: 1, email: 'test@example.com' },
      process.env.JWT_CURRENT_SECRET,
      { expiresIn: '1h', algorithm: 'HS256' }
    );

    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.email).toBe('test@example.com');
  });

  it('rejects internal requests with no service key with 401', async () => {
    const res = await request(app)
      .get('/internal/users/by-auth0-sub')
      .query({ sub: 'auth0|test-user' });

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid internal service credentials');
  });

  it('rejects internal requests with an invalid service key with 401', async () => {
    const res = await request(app)
      .get('/internal/users/by-auth0-sub')
      .query({ sub: 'auth0|test-user' })
      .set('x-internal-service-key', 'incorrect-internal-key');

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid internal service credentials');
  });

  it('allows internal requests with the valid service key', async () => {
    const res = await request(app)
      .get('/internal/users/by-auth0-sub')
      .query({ sub: 'auth0|test-user' })
      .set('x-internal-service-key', process.env.INTERNAL_SERVICE_KEY);

    expect([200, 404]).toContain(res.statusCode);
  });
});
