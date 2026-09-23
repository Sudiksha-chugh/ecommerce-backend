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
const EVENTS_EXCHANGE = 'app.events';

const MAX_PROCESS_RETRIES = 3;
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 1000);

const TRANSIENT_DB_ERROR_CODES = new Set([
  '40001',
  '40P01',
  '53300',
  '57P01',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireOrderLock(orderId) {
  const client = await pool.connect();

  try {
    await client.query(
      'SELECT pg_advisory_lock($1)',
      [orderId]
    );

    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseOrderLock(client, orderId) {
  try {
    await client.query(
      'SELECT pg_advisory_unlock($1)',
      [orderId]
    );
  } finally {
    client.release();
  }
}

function isRetryableError(error) {
  if (!error) return false;

  if (
    error.status === 408 ||
    error.status === 429 ||
    (error.status >= 500 && error.status <= 599)
  ) {
    return true;
  }

  if (error.code && TRANSIENT_DB_ERROR_CODES.has(error.code)) {
    return true;
  }

  if (
    error.code === 'ECONNRESET' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'EAI_AGAIN'
  ) {
    return true;
  }

  // Generic errors from network/catalog calls may be transient,
  // but errors with an explicit status/code must be classified above.
  return !error.status && !error.code;
}

async function processWithRetry(operation) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_PROCESS_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (
        !isRetryableError(error) ||
        attempt === MAX_PROCESS_RETRIES
      ) {
        throw lastError;
      }

      logger.warn('Transient payment workflow failure, retrying', {
        attempt,
        maxAttempts: MAX_PROCESS_RETRIES,
        delayMs: RETRY_DELAY_MS,
        error: error.message,
        status: error.status,
        code: error.code,
      });

      await sleep(RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

async function isPaymentAlreadyCommitted(
  paymentResult,
  paymentProcessedEvent
) {
  const existingPayment = await pool.query(
    `SELECT order_id, user_id, amount, status
     FROM payments
     WHERE order_id = $1`,
    [paymentResult.orderId]
  );

  if (existingPayment.rows.length !== 1) {
    return false;
  }

  const payment = existingPayment.rows[0];

  if (
    payment.user_id !== paymentResult.userId ||
    String(payment.amount) !== String(paymentResult.amount) ||
    payment.status !== paymentResult.status
  ) {
    return false;
  }

  const existingOutbox = await pool.query(
    `SELECT payload
     FROM outbox_events
     WHERE event_type = $1
       AND payload->>'orderId' = $2
     ORDER BY id DESC
     LIMIT 1`,
    [
      'payment_processed',
      String(paymentResult.orderId),
    ]
  );

  if (existingOutbox.rows.length !== 1) {
    return false;
  }

  const payload = existingOutbox.rows[0].payload;

  return (
    payload.orderId === paymentProcessedEvent.orderId &&
    payload.userId === paymentProcessedEvent.userId &&
    String(payload.amount) === String(paymentProcessedEvent.amount) &&
    payload.status === paymentProcessedEvent.status &&
    payload.requestId === paymentProcessedEvent.requestId
  );
}


async function isRefundAlreadyCommitted(
  refundResult,
  refundProcessedEvent
) {
  const existingRefund = await pool.query(
    `SELECT order_id, user_id, amount, status
     FROM refunds
     WHERE order_id = $1`,
    [refundResult.orderId]
  );

  if (existingRefund.rows.length !== 1) {
    return false;
  }

  const refund = existingRefund.rows[0];

  if (
    refund.user_id !== refundResult.userId ||
    String(refund.amount) !== String(refundResult.amount) ||
    refund.status !== refundResult.status
  ) {
    return false;
  }

  const existingOutbox = await pool.query(
    `SELECT payload
     FROM outbox_events
     WHERE event_type = $1
       AND payload->>'orderId' = $2
     ORDER BY id DESC
     LIMIT 1`,
    [
      'refund_processed',
      String(refundResult.orderId),
    ]
  );

  if (existingOutbox.rows.length !== 1) {
    return false;
  }

  const payload = existingOutbox.rows[0].payload;

  return (
    payload.orderId === refundProcessedEvent.orderId &&
    payload.userId === refundProcessedEvent.userId &&
    String(payload.amount) === String(refundProcessedEvent.amount) &&
    payload.status === refundProcessedEvent.status &&
    payload.requestId === refundProcessedEvent.requestId
  );
}

async function startConsumer() {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await connection.createConfirmChannel();

    const incomingQueue = 'order_placed';
    const outgoingQueue = 'payment_processed';
    const dlq = 'order_placed_dlq';
    const refundQueue = 'refund_requested';
    const refundResultQueue = 'refund_processed';
    const refundDlq = 'refund_requested_dlq';

    await channel.assertQueue(incomingQueue, { durable: true });
    await channel.assertQueue(outgoingQueue, { durable: true });
    await channel.assertExchange(EVENTS_EXCHANGE, 'direct', {
      durable: true,
    });

    await channel.assertQueue(dlq, { durable: true });
    await channel.bindQueue(dlq, EVENTS_EXCHANGE, dlq);

    await channel.assertQueue(refundQueue, { durable: true });
    await channel.assertQueue(refundResultQueue, { durable: true });

    await channel.assertQueue(refundDlq, { durable: true });
    await channel.bindQueue(refundDlq, EVENTS_EXCHANGE, refundDlq);

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

      let orderLockClient;
      let order;

      try {
        order = JSON.parse(msg.content.toString());

        orderLockClient = await acquireOrderLock(order.id);

        logger.info('Received order for payment processing', {
          orderId: order.id,
          requestId: order.requestId,
        });

        // Check whether a payment already exists for this order
        const existingPayment = await processWithRetry(() =>
          pool.query(
            `SELECT order_id, user_id, amount, status, transaction_id
             FROM payments
             WHERE order_id = $1`,
            [order.id]
          )
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
        await processWithRetry(() =>
          reserveStock(order.id, stockItems, order.requestId)
        );

        logger.info('Stock reserved successfully', {
          orderId: order.id,
          items: stockItems,
        });

        // Process payment
        const paymentResult = processPayment(order);

        // Release inventory if payment failed
        if (paymentResult.status === 'failed') {
          await processWithRetry(() =>
            releaseReservation(order.id, order.requestId)
          );

          logger.info('Inventory reservation released after payment failure', {
            orderId: order.id,
            items: stockItems,
          });
        }

        // Confirm inventory if payment succeeded
        if (paymentResult.status === 'succeeded') {
          try {
            await processWithRetry(() =>
              confirmReservation(order.id, order.requestId)
            );

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

        // Create event only after the final payment status is known
        const paymentProcessedEvent = {
          ...paymentResult,
          requestId: order.requestId,
        };

        // Save payment and outbox event atomically.
        // Retry the entire transaction so each attempt gets a fresh client.
        await processWithRetry(async () => {
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
              [outgoingQueue, JSON.stringify(paymentProcessedEvent)]
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
            try {
              await client.query('ROLLBACK');
            } catch (rollbackError) {
              logger.error('Payment transaction rollback failed', {
                orderId: order.id,
                error: rollbackError.message,
              });
            }

            if (err.code === '23505') {
              const alreadyCommitted = await isPaymentAlreadyCommitted(
                paymentResult,
                paymentProcessedEvent
              );

              if (alreadyCommitted) {
                logger.warn(
                  'Payment transaction already committed; treating duplicate insert as successful',
                  {
                    orderId: order.id,
                    status: paymentResult.status,
                  }
                );

                return;
              }
            }

            throw err;
          } finally {
            client.release();
          }
        });

        channel.ack(msg);
      } catch (err) {
        logger.error('Failed to process order_placed message', {
          error: err.message,
          status: err.status,
        });

        channel.publish(
          EVENTS_EXCHANGE,
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

        await channel.waitForConfirms();

        logger.warn('Moved unprocessable message to DLQ', {
          dlq,
        });

        channel.ack(msg);
      } finally {
        if (orderLockClient) {
          await releaseOrderLock(orderLockClient, order.id);
        }
      }
    });

    // Refund consumer
    channel.consume(refundQueue, async (msg) => {
      if (msg === null) return;

      let refundLockClient;
      let refundRequest;

      try {
        refundRequest = JSON.parse(msg.content.toString());

        refundLockClient = await acquireOrderLock(refundRequest.orderId);

        logger.info('Received refund request', {
          orderId: refundRequest.orderId,
          requestId: refundRequest.requestId,
        });

        // Check whether this refund was already processed
        const existingRefund = await processWithRetry(() =>
          pool.query(
            `SELECT order_id, user_id, amount, status
             FROM refunds
             WHERE order_id = $1`,
            [refundRequest.orderId]
          )
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
          await processWithRetry(() =>
            refundReservation(
              refundRequest.orderId,
              refundRequest.requestId
            )
          );

          logger.info(
            'Inventory reservation refunded after successful refund',
            {
              orderId: refundResult.orderId,
              requestId: refundRequest.requestId,
            }
          );
        }

        // Add requestId to the outgoing refund event
        const refundProcessedEvent = {
          ...refundResult,
          requestId: refundRequest.requestId,
        };

        // Save refund and outbox event atomically.
        // Retry the entire transaction so each attempt gets a fresh client.
        await processWithRetry(async () => {
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
              [refundResultQueue, JSON.stringify(refundProcessedEvent)]
            );

            await client.query('COMMIT');
          } catch (err) {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackError) {
              logger.error('Refund transaction rollback failed', {
                orderId: refundRequest.orderId,
                error: rollbackError.message,
              });
            }

            if (err.code === '23505') {
              const alreadyCommitted = await isRefundAlreadyCommitted(
                refundResult,
                refundProcessedEvent
              );

              if (alreadyCommitted) {
                logger.warn(
                  'Refund transaction already committed; treating duplicate insert as successful',
                  {
                    orderId: refundRequest.orderId,
                    status: refundResult.status,
                  }
                );

                return;
              }
            }

            throw err;
          } finally {
            client.release();
          }
        });

        logger.info('Refund processed', {
          orderId: refundResult.orderId,
          status: refundResult.status,
          requestId: refundRequest.requestId,
        });

        channel.ack(msg);
      } catch (err) {
        logger.error('Failed to process refund_requested message', {
          error: err.message,
        });

        channel.publish(
          EVENTS_EXCHANGE,
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

        await channel.waitForConfirms();

        logger.warn('Moved unprocessable message to DLQ', {
          dlq: refundDlq,
        });

        channel.ack(msg);
      } finally {
        if (refundLockClient) {
          await releaseOrderLock(
            refundLockClient,
            refundRequest.orderId
          );
        }
      }
    });
  } catch (err) {
    logger.error('Failed to start payments consumer, will retry', {
      error: err.message,
      delayMs: RECONNECT_DELAY_MS,
    });

    setTimeout(startConsumer, RECONNECT_DELAY_MS);
  }
}

module.exports = { startConsumer };