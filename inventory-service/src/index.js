const app = require('./app');
const {
  startInventoryExpirationWorker,
} = require('./inventoryExpiration');
const { startOutboxPoller } = require('./outboxPoller');
const {
  connectInventoryConsumer,
} = require('./consumer');

const PORT = process.env.PORT || 4005;

async function start() {
  app.listen(PORT, () => {
    console.log(`Inventory service running on port ${PORT}`);

    startInventoryExpirationWorker();
    startOutboxPoller();
  });

  try {
    await connectInventoryConsumer();
  } catch (err) {
    console.error(
      'Failed to start inventory RabbitMQ consumer:',
      err.message
    );

    setTimeout(() => {
      connectInventoryConsumer().catch((retryErr) => {
        console.error(
          'Inventory consumer retry failed:',
          retryErr.message
        );
      });
    }, 3000);
  }
}

start();