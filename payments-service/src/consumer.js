const amqp = require('amqplib');
const { processPayment, processRefund } = require('./payment-logic');
const pool = require('./db');
const logger = require('./logger');
const {
  reserveStock,
  confirmReservation,
  releaseReservation,
  refundReservation,
} = require('./catalogClient');

const RECONNECT_DELAY_MS = 3000;

async function startConsumer() {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await connection.createChannel();

    const incomingQueue = 'order_placed';
    const outgoingQueue = 'payment_processed';
    const dlq = 'order_placed_dlq';
    const refundQueue = 'refund_requested';
    const refundResultQueue = 'refund_processed';
    const refundDlq = 'refund_requested_dlq';

    await channel.assertQueue(incomingQueue, { durable: true });
    await channel.assertQueue(outgoingQueue, { durable: true });
    await channel.assertQueue(dlq, { durable: true });
    await channel.assertQueue(refundQueue, { durable: true });
    await channel.assertQueue(refundResultQueue, { durable: true });
    await channel.assertQueue(refundDlq, { durable: true });

    await channel.prefetch(1);

    logger.info('payments-service listening', {
      queues: [incomingQueue, refundQueue],
    });

    connection.on('error', (err) => {
      logger.error('RabbitMQ connection error, will reconnect', {
        error: err.message,
      });
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed, reconnecting', {
        delayMs: RECONNECT_DELAY_MS,
      });

      setTimeout(startConsumer, RECONNECT_DELAY_MS);
    });

    // Order payment consumer
    channel.consume(incomingQueue, async (msg) => {
      if (msg === null) return;

      try {
        const order = JSON.parse(msg.content.toString());

        logger.info('Received order for payment processing', {
          orderId: order.id,
        });

        // Check whether a payment already exists for this order
        const existingPayment = await pool.query(
          `SELECT order_id, user_id, amount, status, transaction_id
           FROM payments
           WHERE order_id = $1`,
          [order.id]
        );

        if (existingPayment.rows.length > 0) {
          const payment = existingPayment.rows[0];

          logger.info('Payment already exists, skipping payment processing', {
            orderId: order.id,
            status: payment.status,
          });

          channel.ack(msg);
          return;
        }

        // Convert order items into inventory items
        const stockItems = order.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
        }));

        // Reserve inventory
        await reserveStock(order.id, stockItems);

        logger.info('Stock reserved successfully', {
          orderId: order.id,
          items: stockItems,
        });

        // Process payment
        const paymentResult = processPayment(order);

        // Release inventory if payment failed
        if (paymentResult.status === 'failed') {
          await releaseReservation(order.id);

          logger.info('Inventory reservation released after payment failure', {
            orderId: order.id,
            items: stockItems,
          });
        }

        // Confirm inventory if payment succeeded
        if (paymentResult.status === 'succeeded') {
          try {
            await confirmReservation(order.id);

            logger.info(
              'Inventory reservation confirmed after payment success',
              {
                orderId: order.id,
                items: stockItems,
              }
            );
          } catch (err) {
            if (err.status === 404) {
              logger.error(
                'Payment succeeded but inventory reservation is no longer active',
                {
                  orderId: order.id,
                  items: stockItems,
                }
              );

              paymentResult.status = 'inventory_failed';
            } else {
              throw err;
            }
          }
        }

        // Save payment and outbox event atomically
        const client = await pool.connect();

        try {
          await client.query('BEGIN');

          // Save payment result
          await client.query(
            `INSERT INTO payments (
              order_id,
              user_id,
              amount,
              status
            )
            VALUES ($1, $2, $3, $4)`,
            [
              paymentResult.orderId,
              paymentResult.userId,
              paymentResult.amount,
              paymentResult.status,
            ]
          );

          logger.info('Payment result saved', {
            orderId: paymentResult.orderId,
            status: paymentResult.status,
          });

          // Save event to outbox
          await client.query(
            `INSERT INTO outbox_events (
              event_type,
              payload
            )
            VALUES ($1, $2)`,
            [outgoingQueue, JSON.stringify(paymentResult)]
          );

          logger.info('Payment result added to outbox', {
            orderId: paymentResult.orderId,
            eventType: outgoingQueue,
          });

          await client.query('COMMIT');

          logger.info('Payment workflow committed', {
            orderId: order.id,
            status: paymentResult.status,
          });
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }

        channel.ack(msg);
      } catch (err) {
        logger.error('Failed to process order_placed message', {
          error: err.message,
          status: err.status,
        });

        channel.sendToQueue(
          dlq,
          Buffer.from(
            JSON.stringify({
              originalMessage: msg.content.toString(),
              error: err.message,
              failedAt: new Date().toISOString(),
            })
          ),
          { persistent: true }
        );

        logger.warn('Moved unprocessable message to DLQ', {
          dlq,
        });

        channel.ack(msg);
      }
    });

    // Refund consumer
    channel.consume(refundQueue, async (msg) => {
      if (msg === null) return;

      try {
        const refundRequest = JSON.parse(msg.content.toString());

        logger.info('Received refund request', {
          orderId: refundRequest.orderId,
        });

        // Check whether this refund was already processed
        const existingRefund = await pool.query(
          `SELECT order_id, user_id, amount, status
           FROM refunds
           WHERE order_id = $1`,
          [refundRequest.orderId]
        );

        if (existingRefund.rows.length > 0) {
          const refund = existingRefund.rows[0];

          logger.info('Refund already exists, skipping refund processing', {
            orderId: refund.order_id,
            status: refund.status,
          });

          // The original outbox event is responsible for publishing
          // the refund_processed result.
          channel.ack(msg);
          return;
        }

        const refundResult = processRefund(refundRequest);

        // Restore inventory only when the refund succeeds
        if (
          refundResult.status === 'refunded' &&
          refundRequest.restoreInventory !== false
        ) {
          await refundReservation(refundRequest.orderId);

          logger.info(
            'Inventory reservation refunded after successful refund',
            {
              orderId: refundResult.orderId,
            }
          );
        }

        const client = await pool.connect();

        try {
          await client.query('BEGIN');

          // Record the refund
          await client.query(
            `INSERT INTO refunds (
              order_id,
              user_id,
              amount,
              status
            )
            VALUES ($1, $2, $3, $4)`,
            [
              refundRequest.orderId,
              refundRequest.userId,
              refundRequest.amount,
              refundResult.status,
            ]
          );

          // Store refund_processed in the outbox
          await client.query(
            `INSERT INTO outbox_events (
              event_type,
              payload
            )
            VALUES ($1, $2)`,
            [refundResultQueue, JSON.stringify(refundResult)]
          );

          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }

        logger.info('Refund processed', {
          orderId: refundResult.orderId,
          status: refundResult.status,
        });

        channel.ack(msg);
      } catch (err) {
        logger.error('Failed to process refund_requested message', {
          error: err.message,
        });

        channel.sendToQueue(
          refundDlq,
          Buffer.from(
            JSON.stringify({
              originalMessage: msg.content.toString(),
              error: err.message,
              failedAt: new Date().toISOString(),
            })
          ),
          { persistent: true }
        );

        logger.warn('Moved unprocessable message to DLQ', {
          dlq: refundDlq,
        });

        channel.ack(msg);
      }
    });
  } catch (err) {
    logger.error('Failed to start payments consumer', {
      error: err.message,
    });

    throw err;
  }
}

module.exports = { startConsumer };