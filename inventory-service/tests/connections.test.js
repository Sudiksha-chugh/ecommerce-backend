const pool = require('../src/db');

describe('database connections', () => {
  it('connects to Postgres', async () => {
    const res = await pool.query('SELECT 1 + 1 AS result');
    expect(res.rows[0].result).toBe(2);
  });
});

afterAll(() => pool.end());
