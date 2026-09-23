
jest.mock('amqplib');

process.env.RETRY_DELAY_MS = '0';

jest.mock('../src/payment-logic', () => ({
  processPayment: jest.fn().mockReturnValue({
    orderId: 1,
    userId: 5,
    amount: '50.00',
    status: 'succeeded',
  }),
  processRefund: jest.fn((refund) => ({
  orderId: refund.orderId,
  status: 'refunded',
  })),
}));

jest.mock('../src/catalogClient', () => ({
  reserveStock: jest.fn().mockResolvedValue({}),
  confirmReservation: jest.fn().mockResolvedValue({}),
  releaseReservation: jest.fn().mockResolvedValue({}),
  decrementStock: jest.fn().mockResolvedValue({}),
  refundReservation: jest.fn().mockResolvedValue({}),
}));

const {
  reserveStock,
  confirmReservation,
  releaseReservation,
  refundReservation,
} = require('../src/catalogClient');

const {
  processPayment,
  processRefund,
} = require('../src/payment-logic');

jest.useFakeTimers();
const amqp = require('amqplib');
const { startConsumer } = require('../src/consumer');
const pool = require('../src/db');

describe('startConsumer', () => {
  let mockChannel;
  let mockConnection;

  beforeEach(() => {
    mockChannel = {
      assertQueue: jest.fn().mockResolvedValue(),
      assertExchange: jest.fn().mockResolvedValue(),
      bindQueue: jest.fn().mockResolvedValue(),
      prefetch: jest.fn().mockResolvedValue(),
      consume: jest.fn(),
      publish: jest.fn(),
      waitForConfirms: jest.fn().mockResolvedValue(),
      ack: jest.fn(),
    };

    mockConnection = {
      createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
      on: jest.fn(),
    };

    amqp.connect = jest.fn().mockResolvedValue(mockConnection);

    reserveStock.mockClear();
    confirmReservation.mockClear();
    releaseReservation.mockClear();
    refundReservation.mockClear();
    processPayment.mockClear();
    processRefund.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('sets up durable queues (including the DLQ) and prefetch on startup', async () => {
    await startConsumer();

    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      'order_placed',
      { durable: true }
    );

    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      'payment_processed',
      { durable: true }
    );

    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      'order_placed_dlq',
      { durable: true }
    );

    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      'refund_requested',
      { durable: true }
    );

    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      'refund_processed',
      { durable: true }
    );

    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      'refund_requested_dlq',
      { durable: true }
    );

    expect(mockChannel.prefetch).toHaveBeenCalledWith(1);
  });

  it('registers reconnect handlers on the connection', async () => {
    await startConsumer();

    expect(mockConnection.on).toHaveBeenCalledWith(
      'error',
      expect.any(Function)
    );

    expect(mockConnection.on).toHaveBeenCalledWith(
      'close',
      expect.any(Function)
    );
  });

  it('processes a valid message, publishes a result, and acks it', async () => {
    jest.useRealTimers();

    await startConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];

    const fakeOrder = {
      id: 1,
      user_id: 5,
      total_amount: '50.00',
      requestId: 'test-request-123',
      items: [
        {
          productId: 1,
          quantity: 1,
        },
      ],
    };

    const fakeMsg = {
      content: Buffer.from(JSON.stringify(fakeOrder)),
    };

    await consumeCallback(fakeMsg);

    const outbox = await pool.query(
      `SELECT event_type, payload, published
       FROM outbox_events
       WHERE event_type = $1
       ORDER BY id DESC
       LIMIT 1`,
      ['payment_processed']
    );

    expect(outbox.rows.length).toBe(1);
    expect(outbox.rows[0].event_type).toBe('payment_processed');
    expect(outbox.rows[0].published).toBe(false);

    const payload = outbox.rows[0].payload;

    expect(payload.orderId).toBe(fakeOrder.id);
    expect(payload.userId).toBe(fakeOrder.user_id);
    expect(payload.amount).toBe(fakeOrder.total_amount);

    expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);

    expect(reserveStock).toHaveBeenCalledWith(
      fakeOrder.id,
      fakeOrder.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
      fakeOrder.requestId
    );
  });

  it('routes a malformed message to the DLQ instead of discarding it, and still acks the original', async () => {
    await startConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];

    const badContent = 'not valid json{{{';

    const badMsg = {
      content: Buffer.from(badContent),
    };

    await expect(consumeCallback(badMsg)).resolves.not.toThrow();

    const dlqCall = mockChannel.publish.mock.calls.find(
      (call) =>
        call[0] === 'app.events' &&
        call[1] === 'order_placed_dlq'
    );

    expect(dlqCall).toBeDefined();

    const dlqPayload = JSON.parse(dlqCall[2].toString());

    expect(dlqPayload.originalMessage).toBe(badContent);
    expect(dlqPayload.error).toContain('JSON');
    expect(dlqPayload.failedAt).toBeDefined();

    expect(mockChannel.ack).toHaveBeenCalledWith(badMsg);
  });

  it('schedules a reconnect attempt when the connection closes', async () => {
    jest.useFakeTimers();

    await startConsumer();

    const closeHandler = mockConnection.on.mock.calls.find(
      (call) => call[0] === 'close'
    )[1];

    const connectCallsBefore = amqp.connect.mock.calls.length;

    closeHandler();

    jest.advanceTimersByTime(3000);

    await Promise.resolve();

    expect(amqp.connect.mock.calls.length).toBeGreaterThan(
      connectCallsBefore
    );
  });
    it('re-registers consumers and prefetches on the new channel after reconnect', async () => {
      jest.useFakeTimers();

    const firstChannel = mockChannel;

    const secondChannel = {
      assertQueue: jest.fn().mockResolvedValue(),
      assertExchange: jest.fn().mockResolvedValue(),
      bindQueue: jest.fn().mockResolvedValue(),
      prefetch: jest.fn().mockResolvedValue(),
      consume: jest.fn(),
      publish: jest.fn(),
      waitForConfirms: jest.fn().mockResolvedValue(),
      ack: jest.fn(),
    };

    mockConnection.createConfirmChannel
      .mockResolvedValueOnce(firstChannel)
      .mockResolvedValueOnce(secondChannel);

    await startConsumer();

    const closeHandler = mockConnection.on.mock.calls.find(
      (call) => call[0] === 'close'
    )[1];

    closeHandler();

    await jest.advanceTimersByTimeAsync(3000);

    expect(mockConnection.createConfirmChannel).toHaveBeenCalledTimes(2);

    expect(secondChannel.assertExchange).toHaveBeenCalledWith(
      'app.events',
      'direct',
      { durable: true }
    );

     expect(secondChannel.prefetch).toHaveBeenCalledWith(1);

     expect(secondChannel.consume).toHaveBeenCalledWith(
       'order_placed',
        expect.any(Function)
      );

       expect(secondChannel.consume).toHaveBeenCalledWith(
         'refund_requested',
          expect.any(Function)
        );
      });
  describe('idempotency', () => {
    beforeAll(() => {
      jest.useRealTimers();
    });

    const pool = require('../src/db');

    beforeEach(async () => {
      await pool.query('DELETE FROM payments');
      await pool.query('DELETE FROM outbox_events');
      await pool.query('DELETE FROM refunds');
    });

    it('processes an order it has not seen before', async () => {
      await startConsumer();

      const consumeCallback = mockChannel.consume.mock.calls[0][1];

      const fakeOrder = {
        id: 500,
        user_id: 1,
        total_amount: '20.00',
        items: [
          {
            productId: 1,
            quantity: 1,
          },
        ],
      };

      processPayment.mockReturnValueOnce({
        orderId: fakeOrder.id,
        userId: fakeOrder.user_id,
        amount: fakeOrder.total_amount,
        status: 'succeeded',
      });

      const fakeMsg = {
        content: Buffer.from(JSON.stringify(fakeOrder)),
      };

      await consumeCallback(fakeMsg);

      const outbox = await pool.query(
        `SELECT event_type, payload, published
         FROM outbox_events
         WHERE event_type = $1
           AND payload->>'orderId' = $2
         ORDER BY id DESC
         LIMIT 1`,
        ['payment_processed', '500']
      );

      expect(outbox.rows.length).toBe(1);
      expect(outbox.rows[0].event_type).toBe('payment_processed');
      expect(outbox.rows[0].published).toBe(false);

      expect(outbox.rows[0].payload.orderId).toBe(500);
      expect(outbox.rows[0].payload.userId).toBe(fakeOrder.user_id);

    });

    it('treats a duplicate payment insert as already committed', async () => {
      const fakeOrder = {
        id: 501,
        user_id: 1,
        total_amount: '20.00',
        requestId: 'ambiguous-commit-501',
        items: [
          {
            productId: 1,
            quantity: 1,
          },
        ],
      };

      const paymentPayload = {
        orderId: fakeOrder.id,
        userId: fakeOrder.user_id,
        amount: fakeOrder.total_amount,
        status: 'succeeded',
        requestId: fakeOrder.requestId,
      };

      await pool.query(
        `INSERT INTO payments (
          order_id,
          user_id,
          amount,
          status
        )
        VALUES ($1, $2, $3, $4)`,
        [
          paymentPayload.orderId,
          paymentPayload.userId,
          paymentPayload.amount,
          paymentPayload.status,
        ]
      );

      await pool.query(
        `INSERT INTO outbox_events (
          event_type,
          payload
        )
        VALUES ($1, $2)`,
        [
          'payment_processed',
          JSON.stringify(paymentPayload),
        ]
      );

      const originalPoolQuery = pool.query;

      const querySpy = jest
        .spyOn(pool, 'query')
        .mockImplementation((query, params) => {
          if (
            typeof query === 'string' &&
            query.includes('transaction_id')
          ) {
            return Promise.resolve({ rows: [] });
          }

          return originalPoolQuery.call(pool, query, params);
        });

      try {
        reserveStock.mockResolvedValueOnce({});
        confirmReservation.mockResolvedValueOnce({});

        processPayment.mockReturnValueOnce(paymentPayload);

        await startConsumer();

        const consumeCallback = mockChannel.consume.mock.calls[0][1];

        const fakeMsg = {
          content: Buffer.from(JSON.stringify(fakeOrder)),
        };

        await consumeCallback(fakeMsg);

        expect(processPayment).toHaveBeenCalledTimes(1);
        expect(reserveStock).toHaveBeenCalledTimes(1);
        expect(confirmReservation).toHaveBeenCalledTimes(1);

        expect(mockChannel.ack).toHaveBeenCalledTimes(1);

        const dlqPublish = mockChannel.publish.mock.calls.find(
          (call) =>
            call[0] === 'app.events' &&
            call[1] === 'order_placed_dlq'
        );

        expect(dlqPublish).toBeUndefined();

        const payments = await originalPoolQuery.call(
          pool,
          `SELECT order_id, user_id, amount, status
           FROM payments
           WHERE order_id = $1`,
          [fakeOrder.id]
        );

        expect(payments.rows.length).toBe(1);
        expect(payments.rows[0].status).toBe('succeeded');

        const outbox = await originalPoolQuery.call(
          pool,
          `SELECT event_type, payload
           FROM outbox_events
           WHERE event_type = $1
             AND payload->>'orderId' = $2`,
          ['payment_processed', String(fakeOrder.id)]
        );

        expect(outbox.rows.length).toBe(1);
        expect(outbox.rows[0].payload.requestId).toBe(
          fakeOrder.requestId
        );
      } finally {
        querySpy.mockRestore();
      }
    });


    it('treats a duplicate refund insert as already committed', async () => {
      const fakeRefund = {
        orderId: 503,
        userId: 1,
        amount: '20.00',
        requestId: 'ambiguous-refund-503',
        restoreInventory: false,
        items: [
          {
            productId: 1,
            quantity: 1,
          },
        ],
      };

      const refundPayload = {
        orderId: fakeRefund.orderId,
        userId: fakeRefund.userId,
        amount: fakeRefund.amount,
        status: 'refunded',
        requestId: fakeRefund.requestId,
      };

      await pool.query(
        `INSERT INTO refunds (
          order_id,
          user_id,
          amount,
          status
        )
        VALUES ($1, $2, $3, $4)`,
        [
          refundPayload.orderId,
          refundPayload.userId,
          refundPayload.amount,
          refundPayload.status,
        ]
      );

      await pool.query(
        `INSERT INTO outbox_events (
          event_type,
          payload
        )
        VALUES ($1, $2)`,
        [
          'refund_processed',
          JSON.stringify(refundPayload),
        ]
      );

     const originalPoolQuery = pool.query;
      let refundLookupCalls = 0;

     const querySpy = jest
       .spyOn(pool, 'query')
       .mockImplementation((query, params) => {
         if (
             typeof query === 'string' &&
             query.includes('FROM refunds') &&
             query.includes('WHERE order_id = $1') &&
             params?.[0] === fakeRefund.orderId
            ) {
              refundLookupCalls += 1;

               if (refundLookupCalls === 1) {
                 return Promise.resolve({ rows: [] });
                }
              }

               return originalPoolQuery.call(pool, query, params);
             });

      try {
        processRefund.mockReturnValueOnce(refundPayload);

        await startConsumer();

        const refundCallback = mockChannel.consume.mock.calls[1][1];

        const fakeMsg = {
          content: Buffer.from(JSON.stringify(fakeRefund)),
        };

        await refundCallback(fakeMsg);

        expect(processRefund).toHaveBeenCalledTimes(1);
        expect(refundReservation).not.toHaveBeenCalled();

        expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);

        const dlqPublish = mockChannel.publish.mock.calls.find(
          (call) =>
            call[0] === 'app.events' &&
            call[1] === 'refund_requested_dlq'
        );

        expect(dlqPublish).toBeUndefined();

        const refunds = await originalPoolQuery.call(
          pool,
          `SELECT order_id, user_id, amount, status
           FROM refunds
           WHERE order_id = $1`,
          [fakeRefund.orderId]
        );

        expect(refunds.rows.length).toBe(1);
        expect(refunds.rows[0].status).toBe('refunded');

        const outbox = await originalPoolQuery.call(
          pool,
          `SELECT event_type, payload
           FROM outbox_events
           WHERE event_type = $1
             AND payload->>'orderId' = $2`,
          ['refund_processed', String(fakeRefund.orderId)]
        );

        expect(outbox.rows.length).toBe(1);
        expect(outbox.rows[0].payload.requestId).toBe(
          fakeRefund.requestId
        );
      } finally {
        querySpy.mockRestore();
      }
    });

    it('retries a transient inventory reservation failure and succeeds', async () => {
      jest.useRealTimers();

      reserveStock
        .mockRejectedValueOnce(
          Object.assign(new Error('Catalog temporarily unavailable'), {
            status: 503,
          })
        )
        .mockResolvedValueOnce({});

      await startConsumer();

      const consumeCallback = mockChannel.consume.mock.calls[0][1];

      const fakeOrder = {
        id: 502,
        user_id: 1,
        total_amount: '20.00',
        requestId: 'retry-reserve-502',
        items: [
          {
            productId: 1,
            quantity: 1,
          },
        ],
      };

      const fakeMsg = {
        content: Buffer.from(JSON.stringify(fakeOrder)),
      };

      processPayment.mockReturnValueOnce({
        orderId: fakeOrder.id,
        userId: fakeOrder.user_id,
        amount: fakeOrder.total_amount,
        status: 'succeeded',
      });

      await consumeCallback(fakeMsg);

      expect(reserveStock).toHaveBeenCalledTimes(2);
      expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);

      const payment = await pool.query(
        `SELECT order_id, status
         FROM payments
         WHERE order_id = $1`,
        [fakeOrder.id]
      );

      expect(payment.rows.length).toBe(1);
      expect(payment.rows[0].status).toBe('succeeded');
    });

    it('does not retry a permanent inventory reservation failure and sends the message to the DLQ', async () => {
      jest.useRealTimers();

      reserveStock.mockRejectedValueOnce(
        Object.assign(new Error('Insufficient stock'), {
          status: 409,
        })
      );

      await startConsumer();

      const consumeCallback = mockChannel.consume.mock.calls[0][1];

      const fakeOrder = {
        id: 503,
        user_id: 1,
        total_amount: '20.00',
        requestId: 'permanent-reserve-503',
        items: [
          {
            productId: 1,
            quantity: 1,
          },
        ],
      };

      const fakeMsg = {
        content: Buffer.from(JSON.stringify(fakeOrder)),
      };

      await consumeCallback(fakeMsg);

      expect(reserveStock).toHaveBeenCalledTimes(1);

      const dlqCall = mockChannel.publish.mock.calls.find(
        (call) =>
          call[0] === 'app.events' &&
          call[1] === 'order_placed_dlq'
      );

      expect(dlqCall).toBeDefined();
      expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);

      const payment = await pool.query(
        `SELECT order_id
         FROM payments
         WHERE order_id = $1`,
        [fakeOrder.id]
      );

      expect(payment.rows.length).toBe(0);
    });

    it('retries a transient payment database failure and eventually processes the order', async () => {
      jest.useRealTimers();

      const originalPoolQuery = pool.query;
      let lookupAttempts = 0;

      pool.query = jest.fn(async (...args) => {
        const sql = typeof args[0] === 'string' ? args[0] : '';

        if (
          sql.includes('SELECT order_id, user_id, amount, status, transaction_id')
        ) {
          lookupAttempts += 1;

          if (lookupAttempts === 1) {
            throw Object.assign(
              new Error('Database temporarily unavailable'),
              { code: 'ECONNRESET' }
            );
          }
        }

        return originalPoolQuery.apply(pool, args);
      });

      try {
        await startConsumer();

        const consumeCallback = mockChannel.consume.mock.calls[0][1];

        const fakeOrder = {
          id: 505,
          user_id: 1,
          total_amount: '20.00',
          requestId: 'retry-db-505',
          items: [
            {
              productId: 1,
              quantity: 1,
            },
          ],
        };

        processPayment.mockReturnValueOnce({
          orderId: fakeOrder.id,
          userId: fakeOrder.user_id,
          amount: fakeOrder.total_amount,
          status: 'succeeded',
        });

        const fakeMsg = {
          content: Buffer.from(JSON.stringify(fakeOrder)),
        };

        await consumeCallback(fakeMsg);

        expect(lookupAttempts).toBe(2);
        expect(reserveStock).toHaveBeenCalledTimes(1);
        expect(confirmReservation).toHaveBeenCalledTimes(1);
        expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);

        const payment = await originalPoolQuery.call(
         pool,
         `SELECT order_id, status
          FROM payments
          WHERE order_id = $1`,
         [fakeOrder.id]
        );

        expect(payment.rows.length).toBe(1);
        expect(payment.rows[0].status).toBe('succeeded');
      } finally {
        pool.query = originalPoolQuery;
      }
    });

    it('processes a valid refund request and publishes the result', async () => {
      await startConsumer();

      const refundCallback = mockChannel.consume.mock.calls[1][1];

      const fakeRefund = {
        orderId: 10,
        userId: 1,
        amount: '20.00',
        items: [
          {
            productId: 1,
            quantity: 1,
          },
        ],
      };

      const fakeMsg = {
        content: Buffer.from(JSON.stringify(fakeRefund)),
      };

      await refundCallback(fakeMsg);

      const outbox = await pool.query(
        `SELECT event_type, payload, published
         FROM outbox_events
         WHERE event_type = $1
           AND payload->>'orderId' = $2
         ORDER BY id DESC
         LIMIT 1`,
        ['refund_processed', '10']
      );

      expect(outbox.rows.length).toBe(1);
      expect(outbox.rows[0].event_type).toBe('refund_processed');
      expect(outbox.rows[0].published).toBe(false);
      expect(outbox.rows[0].payload.orderId).toBe(fakeRefund.orderId);

      expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);
    });

    it('routes a malformed refund message to the refund DLQ and still acks it', async () => {
      await startConsumer();

      const refundCallback = mockChannel.consume.mock.calls[1][1];

      const badMsg = {
        content: Buffer.from('not valid json{{{'),
      };

      await expect(refundCallback(badMsg)).resolves.not.toThrow();

      const dlqCall = mockChannel.publish.mock.calls.find(
        (call) =>
          call[0] === 'app.events' &&
          call[1] === 'refund_requested_dlq'
      );

      expect(dlqCall).toBeDefined();

      expect(mockChannel.ack).toHaveBeenCalledWith(badMsg);
    });

    it('skips processing (but still acks) an order it has already seen', async () => {
      await pool.query(
        `INSERT INTO payments (
        order_id,
        user_id,
        amount,
        status
      )
       VALUES ($1, $2, $3, $4)`,
       [501, 1, '20.00', 'succeeded']
      );

      await startConsumer();

      const consumeCallback = mockChannel.consume.mock.calls[0][1];

      const fakeOrder = {
        id: 501,
        user_id: 1,
        total_amount: '20.00',
      };

      const fakeMsg = {
        content: Buffer.from(JSON.stringify(fakeOrder)),
      };

      await consumeCallback(fakeMsg);

      expect(mockChannel.publish).not.toHaveBeenCalledWith(
        'app.events',
        'payment_processed',
        expect.any(Buffer),
        { persistent: true }
      );
      expect(reserveStock).not.toHaveBeenCalled();
      expect(processPayment).not.toHaveBeenCalled();
      
      expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);
    });
  });
    it('skips processing (but still acks) a refund it has already seen', async () => {
    await pool.query(
      `INSERT INTO refunds (
        order_id,
        user_id,
        amount,
        status
      )
      VALUES ($1, $2, $3, $4)`,
      [501, 1, '20.00', 'refunded']
    );

    await startConsumer();

    const refundCallback = mockChannel.consume.mock.calls[1][1];

    const fakeRefund = {
      orderId: 501,
      userId: 1,
      amount: '20.00',
      requestId: 'test-request-123',
      items: [
        {
          productId: 1,
          quantity: 2,
        },
      ],
    };

    const fakeMsg = {
      content: Buffer.from(JSON.stringify(fakeRefund)),
    };

    await refundCallback(fakeMsg);

    expect(processRefund).not.toHaveBeenCalled();
    expect(refundReservation).not.toHaveBeenCalled();

    expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);
  });
  it('restores inventory when a refund succeeds', async () => {
    await startConsumer();

    const refundCallback = mockChannel.consume.mock.calls[1][1];

    const fakeRefund = {
      orderId: 10,
      userId: 1,
      amount: '20.00',
      requestId: 'test-request-123',
      items: [
        {
          productId: 1,
          quantity: 2,
        },
      ],
    };

    const fakeMsg = {
      content: Buffer.from(JSON.stringify(fakeRefund)),
    };

    await refundCallback(fakeMsg);

    expect(refundReservation).toHaveBeenCalledTimes(1);
    expect(refundReservation).toHaveBeenCalledWith(
      fakeRefund.orderId,
      fakeRefund.requestId
    );

    const outbox = await pool.query(
      `SELECT event_type, payload, published
       FROM outbox_events
       WHERE event_type = $1
         AND payload->>'orderId' = $2
       ORDER BY id DESC
       LIMIT 1`,
      ['refund_processed', '10']
    );

    expect(outbox.rows.length).toBe(1);
    expect(outbox.rows[0].event_type).toBe('refund_processed');
    expect(outbox.rows[0].published).toBe(false);
    expect(outbox.rows[0].payload.orderId).toBe(fakeRefund.orderId);

    expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);
  });

  it('confirms inventory reservation when payment succeeds', async () => {
    jest.useRealTimers();

    processPayment.mockReturnValueOnce({
      orderId: 2,
      userId: 5,
      amount: '50.00',
      status: 'succeeded',
    });

    await startConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];

    const fakeOrder = {
      id: 2,
      user_id: 5,
      total_amount: '50.00',
      requestId: 'test-request-123',
      items: [
        {
          productId: 1,
          quantity: 2,
        },
      ],
    };

    const fakeMsg = {
      content: Buffer.from(JSON.stringify(fakeOrder)),
    };

    await consumeCallback(fakeMsg);

    expect(reserveStock).toHaveBeenCalledWith(
      fakeOrder.id,
      [
        {
          productId: 1,
          quantity: 2,
        },
      ],
      fakeOrder.requestId
    );

    expect(confirmReservation).toHaveBeenCalledWith(
      fakeOrder.id,
      fakeOrder.requestId
    );

    expect(releaseReservation).not.toHaveBeenCalled();
  });

  it('does not restore inventory when a compensation refund succeeds', async () => {
    await startConsumer();

    const refundCallback = mockChannel.consume.mock.calls[1][1];

    const fakeRefund = {
      orderId: 11,
      userId: 1,
      amount: '20.00',
      restoreInventory: false,
      items: [
        {
          productId: 1,
          quantity: 2,
        },
      ],
    };

    const fakeMsg = {
      content: Buffer.from(JSON.stringify(fakeRefund)),
    };

    await refundCallback(fakeMsg);

    expect(refundReservation).not.toHaveBeenCalled();

    const outbox = await pool.query(
      `SELECT event_type, payload, published
       FROM outbox_events
       WHERE event_type = $1
         AND payload->>'orderId' = $2
       ORDER BY id DESC
       LIMIT 1`,
      ['refund_processed', '11']
    );

    expect(outbox.rows.length).toBe(1);
    expect(outbox.rows[0].event_type).toBe('refund_processed');
    expect(outbox.rows[0].published).toBe(false);
    expect(outbox.rows[0].payload.orderId).toBe(fakeRefund.orderId);

    expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);
  });

  it('marks payment as inventory_failed when reservation confirmation returns 404', async () => {
    jest.useRealTimers();

    const error = new Error('Reservation expired');
    error.status = 404;

    confirmReservation.mockRejectedValueOnce(error);

    processPayment.mockReturnValueOnce({
      orderId: 6,
      userId: 5,
      amount: '50.00',
      status: 'succeeded',
    });

    await startConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];

    const fakeOrder = {
      id: 6,
      user_id: 5,
      total_amount: '50.00',
      items: [
        {
          productId: 1,
          quantity: 2,
        },
      ],
    };

    const fakeMsg = {
      content: Buffer.from(JSON.stringify(fakeOrder)),
    };

    await consumeCallback(fakeMsg);

    const result = await pool.query(
      `SELECT status
       FROM payments
       WHERE order_id = $1`,
      [6]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].status).toBe('inventory_failed');

    expect(releaseReservation).not.toHaveBeenCalled();

    expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);
  });

  it('releases inventory reservation when payment fails', async () => {
    jest.useRealTimers();

    processPayment.mockReturnValueOnce({
      orderId: 3,
      userId: 5,
      amount: '50.00',
      status: 'failed',
    });

    await startConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];

    const fakeOrder = {
      id: 3,
      user_id: 5,
      total_amount: '50.00',
      requestId: 'test-request-123',
      items: [
        {
          productId: 1,
          quantity: 2,
        },
      ],
    };

    const fakeMsg = {
      content: Buffer.from(JSON.stringify(fakeOrder)),
    };

    await consumeCallback(fakeMsg);

    expect(releaseReservation).toHaveBeenCalledWith(
      fakeOrder.id,
      fakeOrder.requestId
    );

    const result = await pool.query(
      `SELECT status
       FROM payments
       WHERE order_id = $1`,
      [3]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].status).toBe('failed');

    expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);
  });
  it('handles concurrent duplicate order messages safely', async () => {
  jest.useRealTimers();

  processPayment.mockReturnValue({
    orderId: 502,
    userId: 1,
    amount: '20.00',
    status: 'succeeded',
  });

  await startConsumer();

  const consumeCallback = mockChannel.consume.mock.calls[0][1];

  const fakeOrder = {
    id: 502,
    user_id: 1,
    total_amount: '20.00',
    requestId: 'test-request-123',
    items: [
      {
        productId: 1,
        quantity: 1,
      },
    ],
  };

  const fakeMsg1 = {
    content: Buffer.from(JSON.stringify(fakeOrder)),
  };

  const fakeMsg2 = {
    content: Buffer.from(JSON.stringify(fakeOrder)),
  };

  await Promise.all([
    consumeCallback(fakeMsg1),
    consumeCallback(fakeMsg2),
  ]);

  const payments = await pool.query(
    `SELECT order_id
     FROM payments
     WHERE order_id = $1`,
    [502]
  );

  const outbox = await pool.query(
    `SELECT event_type
     FROM outbox_events
     WHERE event_type = $1
       AND payload->>'orderId' = $2`,
    ['payment_processed', '502']
  );

  expect(payments.rows.length).toBe(1);
  expect(outbox.rows.length).toBe(1);

  expect(processPayment).toHaveBeenCalledTimes(1);
  expect(reserveStock).toHaveBeenCalledTimes(1);
  expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg1);
  expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg2);
});
});
