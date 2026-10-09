'use strict';

const crypto = require('node:crypto');
const { verify, money, id } = require('./verify');
const { parseExactJSON } = require('./inspect');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function fingerprint(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
const commandKeys = new Set(['eventId', 'operationId', 'orderId', 'userId', 'amount', 'items', 'requestId',
  'correlationId', 'attempt', 'reconcileAttempts']);
function text(value) { return typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value); }
function itemsValid(items) {
  return Array.isArray(items) && items.length > 0 && new Set(items.map(item => item?.productId)).size === items.length &&
    items.every(item => item && Object.keys(item).every(key => ['productId', 'quantity'].includes(key)) &&
      id(item.productId) && Number.isInteger(item.productId) && Number.isInteger(item.quantity) && item.quantity > 0);
}
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function relevantEvidence(snapshot) {
  return { environment: snapshot.environment, environmentKind: snapshot.environmentKind, orderId: snapshot.orderId,
    crossDatabaseSnapshot: snapshot.crossDatabaseSnapshot,
    sources: Object.fromEntries(Object.entries(snapshot.sources).map(([service, source]) => [service, {
      identity: source.identity, truncated: source.truncated,
      // Stock changes from unrelated orders must not invalidate an otherwise identical plan.
      records: Object.fromEntries(Object.entries(source.records).filter(([name]) => name !== 'stock')),
    }])) };
}
function plan(snapshot, action) {
  const verification = verify(snapshot);
  const blockers = verification.checks.filter(check => check.status === 'CONFLICT').map(check => check.code);
  const result = { formatVersion: 1, artifact: 'READ_ONLY_REVIEW_PLAN', status: 'BLOCKED',
    environment: snapshot.environment, orderId: snapshot.orderId, action,
    crossDatabaseSnapshot: 'NON_ATOMIC', executionSupported: false, persisted: false,
    blockers, verification, limitations: ['No atomic cross-database snapshot.',
      'No authorization or durable execution journal exists in E.1a.',
      'Inventory results lack complete command causation; absolute stock cannot prove restoration.'] };
  if (action !== 'replay-existing') blockers.push('UNSUPPORTED_ACTION');
  if (blockers.length) return result;
  const orders = snapshot.sources.orders.records;
  const payments = snapshot.sources.payments.records;
  const saga = orders.saga[0];
  const order = orders.order[0];
  const type = { REFUND_PENDING: 'refund_requested', RELEASE_PENDING: 'inventory_release_requested' }[saga.state];
  if (!type) { blockers.push('UNSUPPORTED_SAGA_STATE'); return result; }
  const commands = orders.outbox.filter(row => row.event_type === type);
  const candidates = commands.filter(row => row.payload?.attempt === saga.command_generation);
  if (candidates.length !== 1) { blockers.push(candidates.length ? 'AMBIGUOUS_CURRENT_COMMAND' : 'MISSING_OR_STALE_COMMAND'); return result; }
  const command = candidates[0];
  const payload = command.payload;
  if (!payload || Object.keys(payload).some(key => !commandKeys.has(key)) ||
      !text(payload.eventId) || payload.operationId !== `${snapshot.orderId}:${type}` ||
      payload.orderId !== snapshot.orderId || !id(payload.userId) || String(payload.userId) !== String(order.user_id) ||
      money(payload.amount) === null || money(payload.amount) !== money(order.total_amount) ||
      !itemsValid(payload.items) || !itemsValid(order.items) || canonical(payload.items) !== canonical(order.items) ||
      !Number.isInteger(payload.attempt) || payload.attempt <= 0 ||
      !Object.hasOwn(payload, 'requestId') || !(payload.requestId === null || text(payload.requestId)) ||
      (Object.hasOwn(payload, 'correlationId') && !(payload.correlationId === null || text(payload.correlationId))) ||
      (Object.hasOwn(payload, 'reconcileAttempts') && (!Number.isInteger(payload.reconcileAttempts) || payload.reconcileAttempts < 0 || payload.reconcileAttempts > 3)) ||
      !Number.isInteger(command.id) || command.id <= 0 || typeof command.published !== 'boolean' ||
      !timestamp(command.created_at) || (command.published && !timestamp(command.published_at))) blockers.push('INCOMPLETE_OR_CONFLICTING_COMMAND');
  try { if (typeof command.payloadText !== 'string' || canonical(parseExactJSON(command.payloadText)) !== canonical(payload)) blockers.push('AUTHORITATIVE_PAYLOAD_TEXT_MISMATCH'); } catch { blockers.push('AUTHORITATIVE_PAYLOAD_TEXT_MISMATCH'); }
  if (orders.outbox.filter(row => row.payload?.eventId === payload.eventId).length !== 1) blockers.push('AMBIGUOUS_EVENT_ID');
  if ((!saga.cancel_requested && !(type === 'inventory_release_requested' && saga.failure_state === 'PAYMENT_FAILED')) || (type === 'refund_requested' && !saga.payment_succeeded) ||
      (type === 'inventory_release_requested' && saga.payment_succeeded && !saga.refund_succeeded)) blockers.push('COMPENSATION_PRECONDITIONS_NOT_MET');
  const owner = type === 'refund_requested' ? payments : snapshot.sources.inventory.records;
  const lastTransition = orders.history.at(-1);
  if (!lastTransition || lastTransition.to_state !== saga.state || lastTransition.order_id !== snapshot.orderId ||
      !text(lastTransition.event_id) || !timestamp(lastTransition.created_at)) blockers.push('MISSING_OR_CONFLICTING_TRANSITION_HISTORY');
  if (commands.some(row => row.id !== command.id && !owner.inbox.some(message => message.event_id === row.payload?.eventId))) blockers.push('OTHER_UNRESOLVED_COMMAND');
  for (const [service, source] of Object.entries(snapshot.sources)) {
    if (!Array.isArray(source.records.globalInbox) || !Array.isArray(source.records.globalOutbox)) { blockers.push('GLOBAL_CORRELATION_EVIDENCE_MISSING'); continue; }
    for (const message of source.records.globalInbox.filter(row => [payload.eventId, `${payload.eventId}:result`].includes(row.event_id))) {
      const expectedType = message.event_id === payload.eventId ? type : 'refund_processed';
      if (message.order_id !== snapshot.orderId || (service !== 'inventory' && message.event_type !== expectedType)) blockers.push('GLOBAL_INBOX_ID_CONFLICT');
    }
    for (const eventId of [payload.eventId, `${payload.eventId}:result`]) if (source.records.globalOutbox.filter(row => row.payload?.eventId === eventId).length > 1) blockers.push('AMBIGUOUS_GLOBAL_EVENT_ID');
    for (const event of source.records.globalOutbox.filter(row => [payload.eventId, `${payload.eventId}:result`].includes(row.payload?.eventId))) {
      const isCommand = event.payload.eventId === payload.eventId;
      if ((isCommand ? service !== 'orders' : service !== 'payments') || event.payload.orderId !== snapshot.orderId || event.event_type !== (isCommand ? type : 'refund_processed') || event.payload.operationId !== payload.operationId ||
        (isCommand && event.payloadText !== command.payloadText) || (!isCommand && (event.payload.requestId !== payload.requestId || !['refunded','failed'].includes(event.payload.status))) || !id(event.payload.userId) || String(event.payload.userId) !== String(order.user_id) || money(event.payload.amount) === null || money(event.payload.amount) !== money(order.total_amount)) blockers.push('GLOBAL_OUTBOX_ID_CONFLICT');
    }
  }
  const accepted = (owner.globalInbox || []).filter(row => row.event_id === payload.eventId);
  if (accepted.some(row => row.order_id !== snapshot.orderId || (row.event_type && row.event_type !== type))) blockers.push('OWNER_INBOX_CONFLICT');
  if (type === 'refund_requested' && !accepted.length && (owner.globalOutbox || []).some(row => row.payload?.eventId === `${payload.eventId}:result`)) blockers.push('RESULT_WITHOUT_OWNER_INBOX');
  if (type === 'refund_requested' && accepted.length) {
    const results = owner.outbox.filter(row => row.event_type === 'refund_processed' && row.payload?.eventId === `${payload.eventId}:result`);
    if (results.length !== 1 || results[0].payload.operationId !== payload.operationId ||
        results[0].payload.orderId !== snapshot.orderId || String(results[0].payload.userId) !== String(order.user_id) ||
        results[0].payload.requestId !== payload.requestId ||
        money(results[0].payload.amount) !== money(order.total_amount) || results[0].payload.status !== 'refunded' ||
        owner.refunds.length !== 1 || owner.refunds[0].status !== 'refunded') blockers.push('PROCESSED_REFUND_NOT_REPLAYABLE_AS_SUCCESS');
    if (orders.inbox.some(row => row.event_id === `${payload.eventId}:result` && row.processed_at)) blockers.push('RESULT_ALREADY_CONSUMED_BUT_SAGA_PENDING');
  }
  if (type === 'inventory_release_requested' && accepted.length) blockers.push('INVENTORY_DUPLICATE_RESULT_CORRELATION_UNSUPPORTED');
  if (blockers.length) return result;
  const evidence = relevantEvidence(snapshot);
  result.status = 'REVIEW_REQUIRED';
  result.expectedSaga = { state: saga.state, version: saga.version, commandGeneration: saga.command_generation };
  result.command = structuredClone(command);
  result.commandFingerprint = fingerprint({ eventType: command.event_type, payloadText: command.payloadText });
  result.evidenceFingerprint = fingerprint(evidence);
  result.planFingerprint = fingerprint({ formatVersion: result.formatVersion, environment: snapshot.environment,
    orderId: snapshot.orderId, action, expectedSaga: result.expectedSaga,
    commandFingerprint: result.commandFingerprint, evidenceFingerprint: result.evidenceFingerprint });
  result.publicationDisposition = command.published ? 'EXISTING_PUBLISHED_COMMAND' : 'EXISTING_UNPUBLISHED_COMMAND_OWNER_POLLER_MAY_RETRY';
  return result;
}

module.exports = { plan, canonical, fingerprint, relevantEvidence };
