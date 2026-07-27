const app = require('./app');
const { connectRedis } = require('./redisClient');

const PORT = process.env.PORT || 4002;

async function start() {
  await connectRedis();
  app.listen(PORT, () => {
    console.log(`Cart service running on port ${PORT}`);
  });
}

start();