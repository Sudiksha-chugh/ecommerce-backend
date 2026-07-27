const pool = require('../src/db');

describe('database connection', () => {
  it('connects and can run a simple query', async () => {
    const res = await pool.query('SELECT 1 + 1 AS result');
    expect(res.rows[0].result).toBe(2);
  });

  afterAll(async () => {
    await pool.end();
  });
});