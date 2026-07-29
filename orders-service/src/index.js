const app = require('./app');
const { connectRabbitMQ } = require('./rabbitmq');
const { startOutboxPoller } = require('./outboxPoller');
require('dotenv').config();

const PORT = process.env.PORT || 4003;

async function start() {
  await connectRabbitMQ();
  startOutboxPoller();
  app.listen(PORT, () => {
    console.log(`orders-service running on port ${PORT}`);
  });
}

start();