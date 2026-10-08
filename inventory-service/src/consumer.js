const amqp = require('amqplib');
const logger = require('./logger');
const {
  reserveInventory,
} = require('./inventoryService');

const EVENTS_EXCHANGE = 'app.events';

const RESERVE_QUEUE = 'inventory_reserve_requested';
const RESERVE_DLQ = 'inventory_reserve_requested_dlq';

let connection = null;
let channel = null;

async function connectInventoryConsumer() {
  if (connection && channel) {
    return channel;
  }

  connection = await amqp.connect(process.env.RABBITMQ_URL);

  connection.on('close', () => {
    connection = null;
    channel = null;

    console.error(
      'RabbitMQ connection closed (inventory consumer)'
    );

    setTimeout(() => {
      connectInventoryConsumer().catch((err) => {
        console.error(
          'Inventory consumer reconnect failed:',
          err.message
        );
      });
    }, 3000);
  });

  connection.on('error', (err) => {
    console.error(
      'RabbitMQ connection error (inventory consumer):',
      err.message
    );
  });

  channel = await connection.createChannel();

  await channel.assertExchange(EVENTS_EXCHANGE, 'direct', {
    durable: true,
  });

  await channel.assertQueue(RESERVE_QUEUE, {
    durable: true,
  });

  await channel.assertQueue(RESERVE_DLQ, {
    durable: true,
  });

  await channel.bindQueue(
    RESERVE_QUEUE,
    EVENTS_EXCHANGE,
    'inventory_reserve_requested'
  );

  await channel.bindQueue(
    RESERVE_DLQ,
    EVENTS_EXCHANGE,
    RESERVE_DLQ
  );

  await channel.prefetch(1);

  await channel.consume(
    RESERVE_QUEUE,
    async (msg) => {
      if (!msg) return;

      let payload;

      try {
        payload = JSON.parse(msg.content.toString());

        if (
          !Number.isInteger(payload.orderId) ||
          !Array.isArray(payload.items) ||
          payload.items.length === 0
        ) {
          throw new Error(
            'Invalid inventory reservation request'
          );
        }

        for (const item of payload.items) {
          if (
            !Number.isInteger(item.productId) ||
            !Number.isInteger(item.quantity) ||
            item.quantity <= 0
          ) {
            throw new Error(
              'Invalid inventory reservation item'
            );
          }
        }

        logger.info(
          'Processing inventory reservation request',
          {
            orderId: payload.orderId,
            items: payload.items,
            requestId: payload.requestId,
          }
        );

        const result = await reserveInventory({
          orderId: payload.orderId,
          items: payload.items,
          requestId: payload.requestId || null,
        });

        logger.info(
          'Inventory reservation request processed',
          {
            orderId: payload.orderId,
            failed: result.failed,
            alreadyExists: result.alreadyExists,
            requestId: payload.requestId,
          }
        );

        /*
         * Both success and business failure have already
         * been persisted to the Inventory Outbox.
         */
        channel.ack(msg);
      } catch (error) {
        logger.error(
          'Failed to process inventory reservation request',
          {
            orderId: payload?.orderId,
            error: error.message,
            requestId: payload?.requestId,
          }
        );

        /*
         * Invalid messages are permanent failures.
         */
        if (
          error.message ===
            'Invalid inventory reservation request' ||
          error.message ===
            'Invalid inventory reservation item'
        ) {
          channel.publish(
            EVENTS_EXCHANGE,
            RESERVE_DLQ,
            Buffer.from(msg.content),
            {
              persistent: true,
              contentType: 'application/json',
            }
          );

          channel.ack(msg);
          return;
        }

        /*
         * Technical failures are requeued.
         */
        channel.nack(msg, false, true);
      }
    }
  );

  console.log(
    `inventory-service listening on "${RESERVE_QUEUE}"`
  );

  return channel;
}

module.exports = {
  connectInventoryConsumer,
};