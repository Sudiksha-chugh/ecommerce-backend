const app = require('./app');
const { connectRabbitMQ } = require('./rabbitmq');
const { startConsumer } = require('./consumer');
const { startOutboxPoller } = require('./outboxPoller');
require('dotenv').config();

const PORT = process.env.PORT || 4004;

async function start() {
  try {
    await connectRabbitMQ();
    console.log('Payments RabbitMQ topology initialized');

    app.listen(PORT, () => {
      console.log(`payments-service HTTP server running on port ${PORT}`);
    });

    startConsumer();
    startOutboxPoller();
  } catch (err) {
    console.error(
      `Failed to initialize Payments RabbitMQ: ${err.message}`
    );
    process.exit(1);
  }
}

start();