const fixtureDb=require('../../scripts/phase2/test-support/admin-db')('inventory',require('pg'));
const pool = require("../src/db");
const {
  pollOnce,
  startOutboxPoller,
  stopOutboxPoller,
} = require("../src/outboxPoller");

const rabbitmq = require("../src/rabbitmq");

describe("Inventory Outbox Poller", () => {
  beforeEach(async () => {
    await fixtureDb.query("DELETE FROM outbox_events");

    jest.clearAllMocks();
  });

  afterAll(async () => {
    stopOutboxPoller();
    await pool.end();
  });

  test("publishes unpublished event", async () => {
    await pool.query(
      `
      INSERT INTO outbox_events (event_type, payload)
      VALUES ($1, $2)
      `,
      [
        "inventory_reserved",
        JSON.stringify({
          orderId: 101,
          reservationId: 1,
        }),
      ]
    );

    jest.spyOn(rabbitmq, "publishEvent").mockResolvedValue(true);

    await pollOnce();

    expect(rabbitmq.publishEvent).toHaveBeenCalledTimes(1);

    expect(rabbitmq.publishEvent).toHaveBeenCalledWith(
      "inventory_reserved",
      expect.objectContaining({
        orderId: 101,
        reservationId: 1,
      })
    );
  });

  test("marks event as published after RabbitMQ confirmation", async () => {
    const result = await pool.query(
      `
      INSERT INTO outbox_events (event_type, payload)
      VALUES ($1, $2)
      RETURNING id
      `,
      [
        "inventory_reserved",
        JSON.stringify({
          orderId: 102,
          reservationId: 2,
        }),
      ]
    );

    const eventId = result.rows[0].id;

    jest.spyOn(rabbitmq, "publishEvent").mockResolvedValue(true);

    await pollOnce();

    const event = await pool.query(
      `
      SELECT published
      FROM outbox_events
      WHERE id = $1
      `,
      [eventId]
    );

    expect(event.rows[0].published).toBe(true);
  });

  test("leaves event unpublished when RabbitMQ fails", async () => {
    const result = await pool.query(
      `
      INSERT INTO outbox_events (event_type, payload)
      VALUES ($1, $2)
      RETURNING id
      `,
      [
        "inventory_reserved",
        JSON.stringify({
          orderId: 103,
          reservationId: 3,
        }),
      ]
    );

    const eventId = result.rows[0].id;

    jest
      .spyOn(rabbitmq, "publishEvent")
      .mockRejectedValue(new Error("RabbitMQ unavailable"));

    await expect(pollOnce()).resolves.not.toThrow();

    const event = await pool.query(
      `
      SELECT published
      FROM outbox_events
      WHERE id = $1
      `,
      [eventId]
    );

    expect(event.rows[0].published).toBe(false);
  });

  test("leaves event unpublished when RabbitMQ confirmation fails", async () => {
    const result = await pool.query(
      `
      INSERT INTO outbox_events (event_type, payload)
      VALUES ($1, $2)
      RETURNING id
      `,
      [
        "inventory_reserved",
        JSON.stringify({
          orderId: 104,
          reservationId: 4,
        }),
      ]
    );

    const eventId = result.rows[0].id;

    jest
      .spyOn(rabbitmq, "publishEvent")
      .mockRejectedValue(new Error("Publish confirmation failed"));

    await expect(pollOnce()).resolves.not.toThrow();

    const event = await pool.query(
      `
      SELECT published
      FROM outbox_events
      WHERE id = $1
      `,
      [eventId]
    );

    expect(event.rows[0].published).toBe(false);
  });

  test("retries unpublished event on the next poll", async () => {
    const result = await pool.query(
      `
      INSERT INTO outbox_events (event_type, payload)
      VALUES ($1, $2)
      RETURNING id
      `,
      [
        "inventory_reserved",
        JSON.stringify({
          orderId: 105,
          reservationId: 5,
        }),
      ]
    );

    const eventId = result.rows[0].id;

    const publishMock = jest
      .spyOn(rabbitmq, "publishEvent")
      .mockRejectedValueOnce(new Error("RabbitMQ unavailable"))
      .mockResolvedValueOnce(true);

    // First poll fails
    await pollOnce();

    let event = await pool.query(
      `
      SELECT published
      FROM outbox_events
      WHERE id = $1
      `,
      [eventId]
    );

    expect(event.rows[0].published).toBe(false);

    // Second poll succeeds
    await pollOnce();

    event = await pool.query(
      `
      SELECT published
      FROM outbox_events
      WHERE id = $1
      `,
      [eventId]
    );

    expect(event.rows[0].published).toBe(true);
    expect(publishMock).toHaveBeenCalledTimes(2);
  });

  test("does nothing when there are no unpublished events", async () => {
    const publishMock = jest.spyOn(rabbitmq, "publishEvent");

    await pollOnce();

    expect(publishMock).not.toHaveBeenCalled();
  });

  test("does not publish an already published event", async () => {
    await pool.query(
      `
      INSERT INTO outbox_events
        (event_type, payload, published, published_at)
      VALUES
        ($1, $2, true, NOW())
      `,
      [
        "inventory_reserved",
        JSON.stringify({
          orderId: 106,
          reservationId: 6,
        }),
      ]
    );

    const publishMock = jest.spyOn(rabbitmq, "publishEvent");

    await pollOnce();

    expect(publishMock).not.toHaveBeenCalled();
  });

  test("marks published_at when event is successfully published", async () => {
    const result = await pool.query(
      `
      INSERT INTO outbox_events (event_type, payload)
      VALUES ($1, $2)
      RETURNING id
      `,
      [
        "inventory_reserved",
        JSON.stringify({
          orderId: 107,
          reservationId: 7,
        }),
      ]
    );

    const eventId = result.rows[0].id;

    jest.spyOn(rabbitmq, "publishEvent").mockResolvedValue(true);

    await pollOnce();

    const event = await pool.query(
      `
      SELECT published, published_at
      FROM outbox_events
      WHERE id = $1
      `,
      [eventId]
    );

    expect(event.rows[0].published).toBe(true);
    expect(event.rows[0].published_at).not.toBeNull();
  });
});
afterAll(()=>fixtureDb.end());
