jest.mock('../src/rabbitmq');

const pool = require('../src/db');
const { getChannel } = require('../src/rabbitmq');
const { pollOnce } = require('../src/outboxPoller');

async function insertOutboxEvent(payload) {
  const result = await pool.query(
    `INSERT INTO outbox_events (event_type, payload) VALUES ($1, $2) RETURNING *`,
    ['order_placed', JSON.stringify(payload)]
  );
  return result.rows[0];
}

describe('pollOnce', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM outbox_events');
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('publishes unpublished events and marks them published', async () => {
    const mockPublish = jest.fn();
    const mockWaitForConfirms = jest.fn().mockResolvedValue();

    getChannel.mockReturnValue({
      publish: mockPublish,
      waitForConfirms: mockWaitForConfirms,
    });

    const event = await insertOutboxEvent({ id: 1, user_id: 5, total_amount: '99.99' });

    await pollOnce();

    expect(mockPublish).toHaveBeenCalledWith(
      'app.events',
      'order_placed',
      expect.any(Buffer),
      { persistent: true }
    );
    expect(mockWaitForConfirms).toHaveBeenCalled();

    const check = await pool.query('SELECT * FROM outbox_events WHERE id = $1', [event.id]);
    expect(check.rows[0].published).toBe(true);
    expect(check.rows[0].published_at).not.toBeNull();
  });

  it('leaves events unpublished when RabbitMQ is unavailable', async () => {
    getChannel.mockReturnValue(null);

    const event = await insertOutboxEvent({ id: 2, user_id: 6, total_amount: '50.00' });

    await pollOnce();

    const check = await pool.query('SELECT * FROM outbox_events WHERE id = $1', [event.id]);
    expect(check.rows[0].published).toBe(false);
  });

  it('leaves an event unpublished if RabbitMQ does not confirm the message', async () => {
  getChannel.mockReturnValue({
    publish: jest.fn(),
    waitForConfirms: jest.fn().mockRejectedValue(
      new Error('Publisher confirmation failed')
    ),
  });

  const event = await insertOutboxEvent({
    id: 4,
    user_id: 8,
    total_amount: '25.00',
  });

  await expect(pollOnce()).resolves.not.toThrow();

  const check = await pool.query(
    'SELECT * FROM outbox_events WHERE id = $1',
    [event.id]
  );

  expect(check.rows[0].published).toBe(false);
  expect(check.rows[0].published_at).toBeNull();
});

  it('leaves an event unpublished if publish throws, without crashing the poller', async () => {
    getChannel.mockReturnValue({
      publish: jest.fn(() => {
        throw new Error('Simulated channel failure');
      }),
      waitForConfirms: jest.fn().mockResolvedValue(),
    });

    const event = await insertOutboxEvent({ id: 3, user_id: 7, total_amount: '15.00' });

    await expect(pollOnce()).resolves.not.toThrow();

    const check = await pool.query('SELECT * FROM outbox_events WHERE id = $1', [event.id]);
    expect(check.rows[0].published).toBe(false);
  });
  it('leaves an event unpublished when marking it published fails after confirmation', async () => {
    const mockPublish = jest.fn();
    const mockWaitForConfirms = jest.fn().mockResolvedValue();

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

    getChannel.mockReturnValue({
      publish: mockPublish,
      waitForConfirms: mockWaitForConfirms,
    });

    const event = await insertOutboxEvent({
      id: 5,
      user_id: 9,
      total_amount: '35.00',
    });

    pool.connect = jest.fn().mockResolvedValue(pollerClient);

    try {
      await expect(pollOnce()).resolves.not.toThrow();
    } finally {
      pool.connect = originalConnect;
      realClient.release();
    }

    expect(mockPublish).toHaveBeenCalledWith(
      'app.events',
      'order_placed',
      expect.any(Buffer),
      { persistent: true }
    );

    expect(mockWaitForConfirms).toHaveBeenCalled();

    expect(pollerClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE outbox_events'),
      expect.any(Array)
    );

    const check = await pool.query(
      'SELECT * FROM outbox_events WHERE id = $1',
      [event.id]
    );

    expect(check.rows[0].published).toBe(false);
    expect(check.rows[0].published_at).toBeNull();
  });

  it('recovers an unpublished event on the next poll after a publish failure', async () => {
    const mockPublish = jest.fn();
    const mockWaitForConfirms = jest
      .fn()
      .mockRejectedValueOnce(new Error('Temporary RabbitMQ failure'))
      .mockResolvedValue();

    getChannel.mockReturnValue({
      publish: mockPublish,
      waitForConfirms: mockWaitForConfirms,
    });

    const event = await insertOutboxEvent({
      id: 6,
      user_id: 10,
      total_amount: '45.00',
    });

    // First poll: RabbitMQ confirmation fails.
    await pollOnce();

    let check = await pool.query(
      'SELECT * FROM outbox_events WHERE id = $1',
      [event.id]
    );

    expect(check.rows[0].published).toBe(false);
    expect(check.rows[0].published_at).toBeNull();

    // Second poll: RabbitMQ has recovered.
    await pollOnce();

    check = await pool.query(
      'SELECT * FROM outbox_events WHERE id = $1',
      [event.id]
    );

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockWaitForConfirms).toHaveBeenCalledTimes(2);

    expect(check.rows[0].published).toBe(true);
    expect(check.rows[0].published_at).not.toBeNull();
  });

  it('does nothing when there are no unpublished events', async () => {
    getChannel.mockReturnValue({
      publish: jest.fn(),
      waitForConfirms: jest.fn().mockResolvedValue(),
    });

    await expect(pollOnce()).resolves.not.toThrow();
  });

});