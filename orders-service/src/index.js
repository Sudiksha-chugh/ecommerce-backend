const app = require('./app');
const { connectRabbitMQ } = require('./rabbitmq');
const { startOutboxPoller } = require('./outboxPoller');
require('dotenv').config();

const PORT = process.env.PORT || 4003;
const STARTUP_RETRY_DELAY_MS = 3000;

async function start() {
  try {
    await connectRabbitMQ();
  } catch (err) {
    console.error(`Failed to connect to RabbitMQ on startup, retrying in ${STARTUP_RETRY_DELAY_MS}ms:`, err.message);
    setTimeout(start, STARTUP_RETRY_DELAY_MS);
    return;
  }

  startOutboxPoller();
  app.listen(PORT, () => {
    console.log(`orders-service running on port ${PORT}`);
  });
}

start();