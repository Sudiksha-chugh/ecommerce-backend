jest.mock('amqplib');

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
    };
    amqp.connect = jest.fn().mockResolvedValue(mockConnection);
  });

  it('sets up durable queues (including the DLQ) and prefetch on startup', async () => {
    await startConsumer();

    expect(mockChannel.assertQueue).toHaveBeenCalledWith('order_placed', { durable: true });
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('payment_processed', { durable: true });
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('order_placed_dlq', { durable: true });
    expect(mockChannel.prefetch).toHaveBeenCalledWith(1);
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

    expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
      'order_placed_dlq',
      expect.any(Buffer),
      { persistent: true }
    );

    const dlqCall = mockChannel.sendToQueue.mock.calls.find(call => call[0] === 'order_placed_dlq');
    const dlqPayload = JSON.parse(dlqCall[1].toString());
    expect(dlqPayload.originalMessage).toBe(badContent);
    expect(dlqPayload.error).toContain('JSON');
    expect(dlqPayload.failedAt).toBeDefined();

    expect(mockChannel.ack).toHaveBeenCalledWith(badMsg);
  });
});