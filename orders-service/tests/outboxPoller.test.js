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
    const mockSendToQueue = jest.fn();
    getChannel.mockReturnValue({ sendToQueue: mockSendToQueue });

    const event = await insertOutboxEvent({ id: 1, user_id: 5, total_amount: '99.99' });

    await pollOnce();

    expect(mockSendToQueue).toHaveBeenCalledWith(
      'order_placed',
      expect.any(Buffer),
      { persistent: true }
    );

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

  it('leaves an event unpublished if sendToQueue throws, without crashing the poller', async () => {
    getChannel.mockReturnValue({
      sendToQueue: jest.fn(() => {
        throw new Error('Simulated channel failure');
      }),
    });

    const event = await insertOutboxEvent({ id: 3, user_id: 7, total_amount: '15.00' });

    await expect(pollOnce()).resolves.not.toThrow();

    const check = await pool.query('SELECT * FROM outbox_events WHERE id = $1', [event.id]);
    expect(check.rows[0].published).toBe(false);
  });

  it('does nothing when there are no unpublished events', async () => {
    getChannel.mockReturnValue({ sendToQueue: jest.fn() });

    await expect(pollOnce()).resolves.not.toThrow();
  });
});