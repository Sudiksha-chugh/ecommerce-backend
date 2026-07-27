const request = require('supertest');
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

  it('logs in with correct credentials and returns a JWT', async () => {
    const res = await request(app)
      .post('/login')
      .send({ email: 'logintest@example.com', password: 'correctPass123' });

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
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