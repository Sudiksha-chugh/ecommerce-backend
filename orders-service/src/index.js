const app = require('./app');
const { connectRabbitMQ } = require('./rabbitmq');
require('dotenv').config();

const PORT = process.env.PORT || 4003;

async function start() {
  await connectRabbitMQ();
  app.listen(PORT, () => {
    console.log(`orders-service running on port ${PORT}`);
  });
}

start();