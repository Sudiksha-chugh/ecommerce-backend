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
      publish: jest.fn(),
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

    expect(mockChannel.publish).toHaveBeenCalledWith(
      'app.events',
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

   it('leaves the event unpublished when marking it published fails after confirmation', async () => {
    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ($1, $2)`,
      [
        'payment_processed',
        JSON.stringify({
          orderId: 103,
          status: 'succeeded',
        }),
      ]
    );

    const originalConnect = pool.connect.bind(pool);
    const realClient = await originalConnect();

    const pollerClient = {
      query: jest.fn().mockImplementation((query, params) => {
        if (
          typeof query === 'string' &&
          query.includes('SELECT * FROM outbox_events')
        ) {
          return realClient.query(query, params);
        }

        if (
          typeof query === 'string' &&
          query.includes('UPDATE outbox_events')
        ) {
          return Promise.reject(
            new Error('Database update failed after RabbitMQ confirmation')
          );
        }

        return realClient.query(query, params);
      }),
      release: jest.fn(),
    };

    pool.connect = jest.fn().mockResolvedValue(pollerClient);

    try {
      await pollOnce();
    } finally {
      pool.connect = originalConnect;
      realClient.release();
    }

    expect(mockChannel.publish).toHaveBeenCalledWith(
      'app.events',
      'payment_processed',
      expect.any(Buffer),
      { persistent: true }
    );

    expect(mockChannel.waitForConfirms).toHaveBeenCalled();

    expect(pollerClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE outbox_events'),
      expect.any(Array)
    );

    const result = await client.query(
      `SELECT published, published_at
       FROM outbox_events
       WHERE event_type = $1`,
      ['payment_processed']
    );

    expect(result.rows[0].published).toBe(false);
    expect(result.rows[0].published_at).toBeNull();
  });

    it('recovers an unpublished event on the next poll after a publish failure', async () => {
    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ($1, $2)`,
      [
        'payment_processed',
        JSON.stringify({
          orderId: 104,
          status: 'succeeded',
        }),
      ]
    );

    mockChannel.waitForConfirms.mockRejectedValueOnce(
      new Error('Temporary RabbitMQ failure')
    );

    // First poll: RabbitMQ confirmation fails.
    await pollOnce();

    let result = await client.query(
      `SELECT published, published_at
       FROM outbox_events
       WHERE event_type = $1`,
      ['payment_processed']
    );

    expect(result.rows[0].published).toBe(false);
    expect(result.rows[0].published_at).toBeNull();

    // Second poll: RabbitMQ has recovered.
    await pollOnce();

    result = await client.query(
      `SELECT published, published_at
       FROM outbox_events
       WHERE event_type = $1`,
      ['payment_processed']
    );

    expect(mockChannel.publish).toHaveBeenCalledTimes(2);
    expect(mockChannel.waitForConfirms).toHaveBeenCalledTimes(2);

    expect(result.rows[0].published).toBe(true);
    expect(result.rows[0].published_at).not.toBeNull();
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

    expect(mockChannel.publish).toHaveBeenCalledWith(
      'app.events',
      'payment_processed',
      expect.any(Buffer),
      { persistent: true }
    );

    expect(mockChannel.waitForConfirms).toHaveBeenCalled();
  });

});