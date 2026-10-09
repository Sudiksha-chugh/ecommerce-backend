'use strict';

const { createRequire } = require('node:module');
const path = require('node:path');
const { SERVICES, fail, validateProfile, validateOrderId } = require('./config');
const LIMIT = 1000;
const IDENTITY_SQL = `SELECT current_database() AS database, current_user AS role,
  d.oid::text AS database_oid, inet_server_port() AS server_port,
  current_setting('transaction_read_only') AS read_only,
  current_setting('transaction_isolation') AS isolation,
  r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls AS privileged,
  pg_has_role(current_user, d.datdba, 'USAGE') AS database_owner,
  has_schema_privilege(current_user,'public','CREATE') OR has_database_privilege(current_user,current_database(),'CREATE') AS can_create,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND
      ((c.relkind IN ('r','p','v','f') AND (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
        OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE')))
      OR (c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE')))) AS mutating_privileges,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND pg_has_role(current_user,c.relowner,'USAGE')) AS owns_relations
  FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`;

// Compare decimal values exactly before JSON.parse can round a numeric token.
function decimalKey(token) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw fail('UNSUPPORTED_JSON_PRECISION');
  let coefficient = BigInt(`${match[1]}${match[2]}${match[3] || ''}`);
  let exponent = BigInt(match[4] || '0') - BigInt((match[3] || '').length);
  if (coefficient === 0n) return '0';
  while (coefficient % 10n === 0n) { coefficient /= 10n; exponent++; }
  return `${coefficient}:${exponent}`;
}
function parseExactJSON(text) {
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    if (!match[1]) continue;
    const number = Number(match[1]);
    if (!Number.isFinite(number) || decimalKey(match[1]) !== decimalKey(String(number))) throw fail('UNSUPPORTED_JSON_PRECISION');
  }
  return JSON.parse(text);
}

function defaultClient(spec) {
  const { Client, types } = createRequire(path.resolve(__dirname, '../../orders-service/package.json'))('pg');
  return new Client({ host: spec.host, port: spec.port, database: spec.database, user: spec.user,
    password: spec.password, ssl: false, types: { getTypeParser: (oid, format) => [114, 3802].includes(oid) ? parseExactJSON : types.getTypeParser(oid, format) }, application_name: 'saga-recovery-inspection',
    connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 12000 });
}

const queries = {
  orders: {
    order: `SELECT to_jsonb(x) AS record FROM (SELECT id,user_id,items,total_amount,status,created_at FROM public.orders WHERE id=$1) x`,
    saga: `SELECT to_jsonb(x) AS record FROM (SELECT order_id,state,version,command_generation,cancel_requested,
      payment_succeeded,refund_succeeded,inventory_inactive,failure_state,created_at,updated_at,
      last_error IS NOT NULL AS has_error FROM public.order_sagas WHERE order_id=$1) x`,
    history: 'SELECT to_jsonb(x) AS record FROM public.saga_transitions x WHERE order_id=$1 ORDER BY id LIMIT 1001',
    outbox: `SELECT to_jsonb(x)-'payload' AS record,payload::text AS payload_text FROM public.outbox_events x WHERE payload->>'orderId'=$1::text ORDER BY id LIMIT 1001`,
    inbox: 'SELECT to_jsonb(x) AS record FROM public.inbox_events x WHERE order_id=$1 ORDER BY event_id LIMIT 1001',
  },
  payments: {
    payments: `SELECT to_jsonb(x) AS record FROM (SELECT id,order_id,user_id,amount,status,created_at,updated_at FROM public.payments WHERE order_id=$1) x ORDER BY x.id LIMIT 1001`,
    refunds: `SELECT to_jsonb(x) AS record FROM (SELECT id,order_id,user_id,amount,status,created_at,updated_at FROM public.refunds WHERE order_id=$1) x ORDER BY x.id LIMIT 1001`,
    outbox: `SELECT to_jsonb(x)-'payload' AS record,payload::text AS payload_text FROM public.outbox_events x WHERE payload->>'orderId'=$1::text ORDER BY id LIMIT 1001`,
    inbox: 'SELECT to_jsonb(x) AS record FROM public.inbox_events x WHERE order_id=$1 ORDER BY event_id LIMIT 1001',
  },
  inventory: {
    reservations: 'SELECT to_jsonb(x) AS record FROM public.reservations x WHERE order_id=$1 ORDER BY product_id LIMIT 1001',
    operation: 'SELECT to_jsonb(x) AS record FROM public.inventory_order_operations x WHERE order_id=$1',
    outbox: `SELECT to_jsonb(x)-'payload' AS record,payload::text AS payload_text FROM public.outbox_events x WHERE payload->>'orderId'=$1::text ORDER BY id LIMIT 1001`,
    inbox: 'SELECT to_jsonb(x) AS record FROM public.inbox_events x WHERE order_id=$1 ORDER BY event_id LIMIT 1001',
    stock: `SELECT to_jsonb(x) AS record FROM public.inventory x WHERE product_id IN
      (SELECT product_id FROM public.reservations WHERE order_id=$1) ORDER BY product_id LIMIT 1001`,
  },
};

async function readSource(service, spec, orderId, clientFactory, kind, pending) {
  const client = clientFactory(spec, service);
  let begun = false;
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    begun = true;
    await client.query("SET LOCAL search_path TO pg_catalog, public");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const identity = (await client.query(IDENTITY_SQL)).rows[0];
    if (!identity || identity.database !== spec.database || identity.role !== spec.user ||
        identity.database_oid !== spec.expectedDatabaseOid || identity.server_port !== spec.expectedServerPort ||
        identity.read_only !== 'on' || identity.isolation !== 'repeatable read' ||
        identity.privileged !== false || identity.database_owner !== false || identity.owns_relations !== false ||
        identity.can_create !== false || typeof identity.mutating_privileges !== 'boolean' ||
        (kind !== 'isolated-test' && identity.mutating_privileges)) throw fail('DATABASE_IDENTITY_OR_ROLE_MISMATCH');
    const observedAt = (await client.query('SELECT transaction_timestamp()::text AS observed_at')).rows[0].observed_at;
    const records = {};
    let truncated = false;
    for (const [name, sql] of Object.entries(queries[service])) {
      const rows = (await client.query(sql, [orderId])).rows;
      if (rows.length > LIMIT) truncated = true;
      records[name] = rows.slice(0, LIMIT).map(decodeRow);
    }
    pending.push({ client, records, complete: async ids => {
      records.globalEventIds = ids;
      records.globalInbox = (await client.query('SELECT to_jsonb(x) AS record FROM public.inbox_events x WHERE event_id=ANY($1::text[]) ORDER BY event_id LIMIT 1001', [ids])).rows.map(decodeRow);
      records.globalOutbox = (await client.query("SELECT to_jsonb(x)-'payload' AS record,payload::text AS payload_text FROM public.outbox_events x WHERE payload->>'eventId'=ANY($1::text[]) ORDER BY id LIMIT 1001", [ids])).rows.map(decodeRow);
      for (const name of ['globalInbox', 'globalOutbox']) {
        if (records[name].length > LIMIT) result.truncated = true;
        records[name] = records[name].slice(0, LIMIT);
      }
    } });
    const result = { identity: { database: identity.database, role: identity.role, databaseOid: identity.database_oid,
      host: spec.host, connectionPort: spec.port, serverPort: identity.server_port, readOnly: true,
      roleScope: identity.mutating_privileges ? 'ISOLATED_APPLICATION_ROLE_READ_ONLY_SESSION' : 'READ_ONLY_ROLE' }, observedAt, truncated, records };
    return result;
  } finally {
    if (!pending.some(entry => entry.client === client)) {
      if (begun) await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }
}

async function inspect(profile, order, { clientFactory = defaultClient } = {}) {
  const validated = validateProfile(profile.environment, { kind: profile.kind, databases: profile.databases });
  const orderId = validateOrderId(order);
  const sources = {};
  const pending = [];
  let originalError;
  try {
    for (const service of SERVICES) sources[service] = await readSource(service, validated.databases[service], orderId, clientFactory, validated.kind, pending);
    const ids = [...new Set(Object.values(sources).flatMap(source => source.records.outbox.flatMap(row =>
      typeof row.payload?.eventId === 'string' ? [row.payload.eventId, ...(['payment_requested','refund_requested'].includes(row.event_type) ? [`${row.payload.eventId}:result`] : [])] : [])))].sort();
    for (const entry of pending) await entry.complete(ids);
  } catch (error) { originalError = error; throw error;
  } finally {
    // Each snapshot remains open until all exact owner-result IDs are known.
    const closed = await Promise.allSettled(pending.map(async ({ client }) => {
      try { await client.query('ROLLBACK'); } finally { await client.end(); }
    }));
    if (!originalError && closed.some(result => result.status === 'rejected')) throw fail('CONNECTION_CLEANUP_FAILED');
  }
  return { formatVersion: 1, environment: validated.environment, environmentKind: validated.kind,
    orderId, crossDatabaseSnapshot: 'NON_ATOMIC', sources };
}

// Raw command bodies remain available in memory for exact fingerprinting. Only this
// allowlist reaches stdout; historical arbitrary payload fields are never logged.
const payloadFields = new Set(['eventId', 'operationId', 'orderId', 'userId', 'amount', 'items',
  'requestId', 'correlationId', 'attempt', 'reconcileAttempts', 'status', 'allInactive']);
function publicItems(items) {
  return Array.isArray(items) ? items.map(item => ({
    productId: Number.isInteger(item?.productId) && item.productId > 0 ? item.productId : null,
    quantity: Number.isInteger(item?.quantity) && item.quantity > 0 ? item.quantity : null,
  })) : null;
}
function publicPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { redacted: true };
  const result = {};
  for (const key of Object.keys(payload)) {
    if (!payloadFields.has(key)) { result.redactedFields = true; continue; }
    const value = payload[key];
    if (key === 'items') {
      result.items = publicItems(value);
    } else if (['string', 'number', 'boolean'].includes(typeof value) || value === null) result[key] = value;
    else result.redactedFields = true;
  }
  return result;
}
function decodeRow(row) {
  const record = { ...row.record };
  if (row.payload_text !== undefined) {
    record.payloadText = row.payload_text;
    try { record.payload = parseExactJSON(row.payload_text); }
    catch { record.payload = null; record.payloadUnsafe = true; }
  }
  return record;
}
function publicInspection(snapshot) {
  const result = structuredClone(snapshot);
  for (const source of Object.values(result.sources)) {
    for (const name of ['outbox', 'globalOutbox']) source.records[name] = (source.records[name] || []).map(({ payloadText, ...row }) => ({ ...row, payload: publicPayload(row.payload) }));
    if (source.records.order) source.records.order = source.records.order.map(row => ({ ...row,
      items: publicItems(row.items) }));
  }
  return result;
}

module.exports = { inspect, publicInspection, publicPayload, IDENTITY_SQL, parseExactJSON, defaultClient };
