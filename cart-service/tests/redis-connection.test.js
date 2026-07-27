const { client, connectRedis } = require('../src/redisClient');

describe('Redis connection', () => {
  beforeAll(async () => {
    await connectRedis();
  });

  afterAll(async () => {
    await client.quit();
  });

  it('can set and get a value', async () => {
    await client.set('test:key', 'hello');
    const value = await client.get('test:key');
    expect(value).toBe('hello');
    await client.del('test:key');
  });
});