jest.mock('../src/rabbitmq', () => ({
  getChannel: jest.fn(),
  connectRabbitMQ: jest.fn(),
}));

const pool = require('../src/db');
const {
  getChannel,
  connectRabbitMQ,
} = require('../src/rabbitmq');

const { pollOnce } = require('../src/outboxPoller');

describe('payments outbox poller', () => {
  let client;
  let mockChannel;

  beforeEach(async () => {
    mockChannel = {
      assertQueue: jest.fn().mockResolvedValue(),
      sendToQueue: jest.fn(),
      waitForConfirms: jest.fn().mockResolvedValue(),
    };

    client = await pool.connect();

    await client.query('DELETE FROM outbox_events');

    getChannel.mockReset();
    connectRabbitMQ.mockReset();

    getChannel.mockReturnValue(mockChannel);
  });

  afterEach(() => {
    client.release();
  });

  it('publishes an event and marks it as published after confirmation', async () => {
    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ($1, $2)`,
      [
        'payment_processed',
        JSON.stringify({
          orderId: 100,
          userId: 1,
          amount: '50.00',
          status: 'succeeded',
        }),
      ]
    );

    await pollOnce();

    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      'payment_processed',
      { durable: true }
    );

    expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
      'payment_processed',
      expect.any(Buffer),
      { persistent: true }
    );

    expect(mockChannel.waitForConfirms).toHaveBeenCalled();

    const result = await client.query(
      `SELECT published, published_at
       FROM outbox_events
       WHERE event_type = $1`,
      ['payment_processed']
    );

    expect(result.rows[0].published).toBe(true);
    expect(result.rows[0].published_at).not.toBeNull();
  });

  it('leaves the event unpublished when publisher confirmation fails', async () => {
    mockChannel.waitForConfirms.mockRejectedValueOnce(
      new Error('Publisher confirm failed')
    );

    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ($1, $2)`,
      [
        'payment_processed',
        JSON.stringify({
          orderId: 101,
          status: 'succeeded',
        }),
      ]
    );

    await pollOnce();

    const result = await client.query(
      `SELECT published, published_at
       FROM outbox_events
       WHERE event_type = $1`,
      ['payment_processed']
    );

    expect(result.rows[0].published).toBe(false);
    expect(result.rows[0].published_at).toBeNull();
  });

  it('reconnects when RabbitMQ channel is unavailable', async () => {
    getChannel.mockReturnValue(null);
    connectRabbitMQ.mockResolvedValue(mockChannel);

    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ($1, $2)`,
      [
        'payment_processed',
        JSON.stringify({
          orderId: 102,
          status: 'succeeded',
        }),
      ]
    );

    await pollOnce();

    expect(connectRabbitMQ).toHaveBeenCalled();

    expect(mockChannel.sendToQueue).toHaveBeenCalled();
    expect(mockChannel.waitForConfirms).toHaveBeenCalled();
  });
});
