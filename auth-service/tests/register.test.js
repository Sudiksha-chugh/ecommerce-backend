const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db');

describe('POST /register', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM users');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates a new user and returns 201 with user info (no password)', async () => {
    const res = await request(app)
      .post('/register')
      .send({ email: 'test@example.com', password: 'securePass123' });

    expect(res.statusCode).toBe(201);
    expect(res.body.email).toBe('test@example.com');
    expect(res.body.id).toBeDefined();
    expect(res.body.password).toBeUndefined();
    expect(res.body.password_hash).toBeUndefined();
  });
});