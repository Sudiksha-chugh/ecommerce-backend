jest.mock('amqplib');
jest.useFakeTimers();

const amqp = require('amqplib');
const { startConsumer } = require('../src/consumer');

describe('startConsumer', () => {
  let mockChannel;
  let mockConnection;

  beforeEach(() => {
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
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('sets up durable queues (including the DLQ) and prefetch on startup', async () => {
    await startConsumer();

    expect(mockChannel.assertQueue).toHaveBeenCalledWith('order_placed', { durable: true });
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('payment_processed', { durable: true });
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('order_placed_dlq', { durable: true });
    expect(mockChannel.prefetch).toHaveBeenCalledWith(1);
  });

  it('registers reconnect handlers on the connection', async () => {
    await startConsumer();

    expect(mockConnection.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockConnection.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('processes a valid message, publishes a result, and acks it', async () => {
    await startConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const fakeOrder = { id: 1, user_id: 5, total_amount: '50.00' };
    const fakeMsg = { content: Buffer.from(JSON.stringify(fakeOrder)) };

    await consumeCallback(fakeMsg);

    expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
      'payment_processed',
      expect.any(Buffer),
      { persistent: true }
    );
    expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);
  });

  it('routes a malformed message to the DLQ instead of discarding it, and still acks the original', async () => {
    await startConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const badContent = 'not valid json{{{';
    const badMsg = { content: Buffer.from(badContent) };

    await expect(consumeCallback(badMsg)).resolves.not.toThrow();

    const dlqCall = mockChannel.sendToQueue.mock.calls.find(call => call[0] === 'order_placed_dlq');
    expect(dlqCall).toBeDefined();

    const dlqPayload = JSON.parse(dlqCall[1].toString());
    expect(dlqPayload.originalMessage).toBe(badContent);
    expect(dlqPayload.error).toContain('JSON');
    expect(dlqPayload.failedAt).toBeDefined();

    expect(mockChannel.ack).toHaveBeenCalledWith(badMsg);
  });

  it('schedules a reconnect attempt when the connection closes', async () => {
    await startConsumer();

    const closeHandler = mockConnection.on.mock.calls.find(call => call[0] === 'close')[1];
    const connectCallsBefore = amqp.connect.mock.calls.length;

    closeHandler();
    jest.advanceTimersByTime(3000);
    await Promise.resolve();

    expect(amqp.connect.mock.calls.length).toBeGreaterThan(connectCallsBefore);
  });
    describe('idempotency', () => {
  beforeAll(() => {
    jest.useRealTimers();
  });

  const pool = require('../src/db');

  afterEach(async () => {
    await pool.query('DELETE FROM processed_orders');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('processes an order it has not seen before', async () => {
    await startConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const fakeOrder = { id: 500, user_id: 1, total_amount: '20.00' };
    const fakeMsg = { content: Buffer.from(JSON.stringify(fakeOrder)) };

    await consumeCallback(fakeMsg);

    expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
      'payment_processed',
      expect.any(Buffer),
      { persistent: true }
    );

    const check = await pool.query('SELECT * FROM processed_orders WHERE order_id = $1', [500]);
    expect(check.rows.length).toBe(1);
  });

  it('skips processing (but still acks) an order it has already seen', async () => {
    await pool.query('INSERT INTO processed_orders (order_id) VALUES ($1)', [501]);

    await startConsumer();

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const fakeOrder = { id: 501, user_id: 1, total_amount: '20.00' };
    const fakeMsg = { content: Buffer.from(JSON.stringify(fakeOrder)) };

    await consumeCallback(fakeMsg);

    expect(mockChannel.sendToQueue).not.toHaveBeenCalledWith(
      'payment_processed',
      expect.any(Buffer),
      { persistent: true }
    );
    expect(mockChannel.ack).toHaveBeenCalledWith(fakeMsg);
  });
});
});