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
      prefetch: jest.fn().mockResolvedValue(),
      consume: jest.fn(),
      sendToQueue: jest.fn(),
      ack: jest.fn(),
    };
    mockConnection = {
      createChannel: jest.fn().mockResolvedValue(mockChannel),
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

    expect(mockChannel.assertQueue).toHaveBeenCalledWith('payment_processed', { durable: true });
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('payment_processed_dlq', { durable: true });
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

    const dlqCall = mockChannel.sendToQueue.mock.calls.find(call => call[0] === 'payment_processed_dlq');
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
});