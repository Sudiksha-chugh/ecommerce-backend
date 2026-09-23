jest.mock('amqplib');

const amqp = require('amqplib');
const pool = require('../src/db');
const { startPaymentConsumer } = require('../src/paymentConsumer');

describe('startPaymentConsumer', () => {
  let mockChannel;
  let mockConnection;
  let testOrderId;

  beforeEach(async () => {
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

    const result = await pool.query(
      `INSERT INTO orders (user_id, items, total_amount) VALUES ($1, $2, $3) RETURNING id`,
      [1, JSON.stringify([{ productId: 1, quantity: 1 }]), '10.00']
    );
    testOrderId = result.rows[0].id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM orders');
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('sets up durable queues (including the DLQ) and prefetch on startup', async () => {
    await startPaymentConsumer();

    expect(mockChannel.assertExchange).toHaveBeenCalledWith(
      'app.events',
      'direct',
      { durable: true }
    );
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('payment_processed', { durable: true });
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('payment_processed_dlq', { durable: true });
    expect(mockChannel.bindQueue).toHaveBeenCalledWith(
      'payment_processed_dlq',
      'app.events',
      'payment_processed_dlq'
    );
    expect(mockChannel.prefetch).toHaveBeenCalledWith(1);
  });

  it('updates the order status when a valid payment_processed message arrives', async () => {
    await startPaymentConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const result = { orderId: testOrderId, userId: 1, amount: '10.00', status: 'succeeded' };
    const msg = { content: Buffer.from(JSON.stringify(result)) };

    await consumeCallback(msg);

    const check = await pool.query('SELECT status FROM orders WHERE id = $1', [testOrderId]);
    expect(check.rows[0].status).toBe('succeeded');
    expect(mockChannel.ack).toHaveBeenCalledWith(msg);
  });

  it('logs and acks (without crashing) a message for a non-existent order', async () => {
    await startPaymentConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const result = { orderId: 999999, userId: 1, amount: '10.00', status: 'succeeded' };
    const msg = { content: Buffer.from(JSON.stringify(result)) };

    await expect(consumeCallback(msg)).resolves.not.toThrow();
    expect(mockChannel.ack).toHaveBeenCalledWith(msg);
  });

  it('routes a malformed message to the DLQ and still acks it', async () => {
    await startPaymentConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const msg = { content: Buffer.from('not valid json{{{') };

    await expect(consumeCallback(msg)).resolves.not.toThrow();

    const dlqCall = mockChannel.publish.mock.calls.find(
      (call) =>
        call[0] === 'app.events' &&
        call[1] === 'payment_processed_dlq'
    );
    expect(dlqCall).toBeDefined();
    expect(mockChannel.ack).toHaveBeenCalledWith(msg);
  });

  it('schedules a reconnect attempt when the connection closes', async () => {
    jest.useFakeTimers();

    await startPaymentConsumer();

    const closeHandler = mockConnection.on.mock.calls.find(call => call[0] === 'close')[1];
    const connectCallsBefore = amqp.connect.mock.calls.length;

    closeHandler();
    jest.advanceTimersByTime(3000);
    await Promise.resolve();

    expect(amqp.connect.mock.calls.length).toBeGreaterThan(connectCallsBefore);

    jest.useRealTimers();
  });
    it('re-registers the payment consumer and prefetches on the new channel after reconnect', async () => {
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

    await startPaymentConsumer();

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
      'payment_processed',
      expect.any(Function)
    );

    expect(secondChannel.consume).toHaveBeenCalledWith(
      'refund_processed',
      expect.any(Function)
    );

    jest.useRealTimers();
  });

  it('updates the order status to inventory_failed when inventory confirmation fails', async () => {
  await startPaymentConsumer();

  const consumeCallback = mockChannel.consume.mock.calls[0][1];

  const result = {
    orderId: testOrderId,
    userId: 1,
    amount: '10.00',
    status: 'inventory_failed',
  };

  const msg = {
    content: Buffer.from(JSON.stringify(result)),
  };

  await consumeCallback(msg);

  const check = await pool.query(
    'SELECT status FROM orders WHERE id = $1',
    [testOrderId]
  );

  expect(check.rows[0].status).toBe('inventory_failed');
  expect(mockChannel.ack).toHaveBeenCalledWith(msg);
});
  it('does not overwrite a cancelled order with a late payment event', async () => {
  await pool.query(
    `UPDATE orders SET status = 'cancelled' WHERE id = $1`,
    [testOrderId]
  );

  await startPaymentConsumer();

  const consumeCallback = mockChannel.consume.mock.calls[0][1];

  const result = {
    orderId: testOrderId,
    userId: 1,
    amount: '10.00',
    status: 'succeeded',
  };

  const msg = {
    content: Buffer.from(JSON.stringify(result)),
  };

  await consumeCallback(msg);

  const check = await pool.query(
    'SELECT status FROM orders WHERE id = $1',
    [testOrderId]
  );

  expect(check.rows[0].status).toBe('cancelled');
  expect(mockChannel.ack).toHaveBeenCalledWith(msg);
});
 it('does not apply a refund event to an order that is not refund_pending', async () => {
  await pool.query(
    `UPDATE orders SET status = 'succeeded' WHERE id = $1`,
    [testOrderId]
  );

  await startPaymentConsumer();

  const refundConsumeCallback = mockChannel.consume.mock.calls[1][1];

  const result = {
    orderId: testOrderId,
    userId: 1,
    amount: '10.00',
    status: 'refunded',
  };

  const msg = {
    content: Buffer.from(JSON.stringify(result)),
  };

  await refundConsumeCallback(msg);

  const check = await pool.query(
    'SELECT status FROM orders WHERE id = $1',
    [testOrderId]
  );

  expect(check.rows[0].status).toBe('succeeded');
  expect(mockChannel.ack).toHaveBeenCalledWith(msg);
});

  it('retries a transient database failure and succeeds on the third attempt', async () => {
    process.env.RETRY_DELAY_MS = '0';

    await startPaymentConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const result = {
      orderId: testOrderId,
      userId: 1,
      amount: '10.00',
      status: 'succeeded',
    };

    const msg = {
      content: Buffer.from(JSON.stringify(result)),
    };

    const originalQuery = pool.query.bind(pool);
    let attempts = 0;

    jest.spyOn(pool, 'query').mockImplementation(async (...args) => {
      const query = String(args[0]);

      if (query.includes('UPDATE orders') && query.includes("status = 'pending'")) {
        attempts += 1;

        if (attempts < 3) {
          const error = new Error('temporary database failure');
          error.code = 'ECONNRESET';
          throw error;
        }
      }

      return originalQuery(...args);
    });

    try {
      const processingPromise = consumeCallback(msg);

      await processingPromise;

      const check = await originalQuery(
        'SELECT status FROM orders WHERE id = $1',
        [testOrderId]
      );

      expect(attempts).toBe(3);
      expect(check.rows[0].status).toBe('succeeded');
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    } finally {
      pool.query.mockRestore();
      delete process.env.RETRY_DELAY_MS;
    }
  });

  it('sends the message to the DLQ after all database retry attempts fail', async () => {
    process.env.RETRY_DELAY_MS = '0';

    await startPaymentConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const result = {
      orderId: testOrderId,
      userId: 1,
      amount: '10.00',
      status: 'succeeded',
    };

    const msg = {
      content: Buffer.from(JSON.stringify(result)),
    };

    const originalQuery = pool.query.bind(pool);
    let attempts = 0;

    jest.spyOn(pool, 'query').mockImplementation(async (...args) => {
      const query = String(args[0]);

      if (query.includes('UPDATE orders') && query.includes("status = 'pending'")) {
        attempts += 1;

        const error = new Error('persistent database failure');
        error.code = 'ECONNRESET';
        throw error;
      }

      return originalQuery(...args);
    });

    try {
      const processingPromise = consumeCallback(msg);

      await processingPromise;

      const dlqCall = mockChannel.publish.mock.calls.find(
        (call) =>
          call[0] === 'app.events' &&
          call[1] === 'payment_processed_dlq'
      );

      expect(attempts).toBe(3);
      expect(dlqCall).toBeDefined();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    } finally {
      pool.query.mockRestore();
      delete process.env.RETRY_DELAY_MS;
    }
  });

  it('sends a permanent database error directly to the DLQ without retrying', async () => {
    process.env.RETRY_DELAY_MS = '0';

    await startPaymentConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const result = {
      orderId: testOrderId,
      userId: 1,
      amount: '10.00',
      status: 'succeeded',
    };

    const msg = {
      content: Buffer.from(JSON.stringify(result)),
    };

    const originalQuery = pool.query.bind(pool);
    let attempts = 0;

    jest.spyOn(pool, 'query').mockImplementation(async (...args) => {
      const query = String(args[0]);

      if (
        query.includes('UPDATE orders') &&
        query.includes("status = 'pending'")
      ) {
        attempts += 1;

        const error = new Error('duplicate order state');
        error.code = '23505';
        throw error;
      }

      return originalQuery(...args);
    });

    try {
      await consumeCallback(msg);

      const dlqCall = mockChannel.publish.mock.calls.find(
        (call) =>
          call[0] === 'app.events' &&
          call[1] === 'payment_processed_dlq'
      );

      expect(attempts).toBe(1);
      expect(dlqCall).toBeDefined();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    } finally {
      pool.query.mockRestore();
      delete process.env.RETRY_DELAY_MS;
    }
  });

});
