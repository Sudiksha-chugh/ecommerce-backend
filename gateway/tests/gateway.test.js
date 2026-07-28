const request = require('supertest');
const express = require('express');

describe('API gateway routing', () => {
  let fakeAuthService;
  let fakeAuthServer;
  let app;

  beforeAll((done) => {
    fakeAuthService = express();
    fakeAuthService.use(express.json());
    fakeAuthService.post('/register', (req, res) => {
      res.status(201).json({ received: req.body });
    });

    fakeAuthServer = fakeAuthService.listen(0, () => {
      const port = fakeAuthServer.address().port;
      process.env.AUTH_SERVICE_URL = `http://localhost:${port}`;
      process.env.CATALOG_SERVICE_URL = 'http://localhost:1';
      process.env.CART_SERVICE_URL = 'http://localhost:1';
      process.env.ORDERS_SERVICE_URL = 'http://localhost:1';

      delete require.cache[require.resolve('../src/app')];
      app = require('../src/app');
      done();
    });
  });

  afterAll((done) => {
    fakeAuthServer.close(done);
  });

  it('forwards /auth/register to the auth service correctly', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'test@example.com' });

    expect(res.statusCode).toBe(201);
    expect(res.body.received.email).toBe('test@example.com');
  });

  it('returns 503 when the target service is unreachable', async () => {
    const res = await request(app).get('/products/1');
    expect(res.statusCode).toBe(503);
  });
});