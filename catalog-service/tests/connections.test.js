const pool = require('../src/db');
const esClient = require('../src/es');

describe('database connections', () => {
  it('connects to Postgres', async () => {
    const res = await pool.query('SELECT 1 + 1 AS result');
    expect(res.rows[0].result).toBe(2);
  });

  it('connects to Elasticsearch', async () => {
    const health = await esClient.cluster.health();
    expect(health.status).toBeDefined();
  });

  afterAll(async () => {
    await pool.end();
  });
});