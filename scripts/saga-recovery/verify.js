'use strict';

const STATES = new Set(['PENDING', 'CANCEL_REQUESTED', 'STOCK_RESERVED', 'PAYMENT_AUTHORIZED',
  'CONFIRMED', 'REFUND_PENDING', 'REFUND_FAILED', 'RELEASE_PENDING', 'CANCELLED']);
function money(value) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) return null;
  const text = String(value);
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fractional = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0'));
}
function id(value) { return ['string', 'number'].includes(typeof value) && /^[1-9][0-9]*$/.test(String(value)) && Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647; }
function matchesFinancial(record, order) {
  return !!order && id(record.user_id) && id(record.order_id) && Number(record.order_id) === Number(order.id) &&
    String(record.user_id) === String(order.user_id) && money(record.amount) !== null && money(record.amount) === money(order.total_amount);
}
// Shared by plan (through verify) and terminal verification.
function collisions(snapshot) {
  const failures = [];
  const sources = snapshot.sources || {};
  const events = Object.entries(sources).flatMap(([service, source]) => (source.records.outbox || []).map(row => ({ service, row })));
  const owners = { payment_processed: 'payments', refund_processed: 'payments', inventory_reserved: 'inventory', inventory_reservation_failed: 'inventory', inventory_confirmed: 'inventory', inventory_confirmation_failed: 'inventory', inventory_released: 'inventory', inventory_expired: 'inventory' };
  const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
  for (const { service: owner, row } of events) {
    const eventId = row.payload?.eventId;
    if (typeof eventId !== 'string' || !eventId || row.payload.orderId !== snapshot.orderId || (owners[row.event_type] || 'orders') !== owner) { failures.push('GLOBAL_EVENT_ID_CONFLICT'); continue; }
    for (const [service, source] of Object.entries(sources)) {
      const records = source.records;
      if (!Array.isArray(records.globalInbox) || !Array.isArray(records.globalOutbox) || (records.globalEventIds && !records.globalEventIds.includes(eventId))) { failures.push('GLOBAL_CORRELATION_EVIDENCE_MISSING'); continue; }
      const copies = records.globalOutbox.filter(event => event.payload?.eventId === eventId);
      if (copies.length > 1 || copies.some(event => service !== owner || event.event_type !== row.event_type || stable(event.payload) !== stable(row.payload))) failures.push('GLOBAL_OUTBOX_ID_CONFLICT');
      for (const message of records.globalInbox.filter(message => message.event_id === eventId)) {
        const recipient = row.event_type.endsWith('_requested') ? (row.event_type.startsWith('inventory_') ? 'inventory' : 'payments') : 'orders';
        if (service !== recipient || message.order_id !== snapshot.orderId || (message.event_type !== undefined && message.event_type !== row.event_type)) failures.push('GLOBAL_INBOX_ID_CONFLICT');
      }
    }
  }
  // Only Payments defines deterministic command-to-result identities.
  for (const command of sources.orders?.records.outbox || []) {
    const resultType = { payment_requested: 'payment_processed', refund_requested: 'refund_processed' }[command.event_type];
    if (!resultType || typeof command.payload?.eventId !== 'string') continue;
    const payload = command.payload;
    const resultId = `${payload.eventId}:result`;
    for (const [service, source] of Object.entries(sources)) {
      const records = source.records;
      if (!Array.isArray(records.globalInbox) || !Array.isArray(records.globalOutbox) ||
          (records.globalEventIds && !records.globalEventIds.includes(resultId))) {
        failures.push('GLOBAL_CORRELATION_EVIDENCE_MISSING'); continue;
      }
      const results = records.globalOutbox.filter(row => row.payload?.eventId === resultId);
      if (results.length > 1 || results.some(row => service !== 'payments' || row.event_type !== resultType ||
          row.payload.orderId !== payload.orderId || row.payload.operationId !== payload.operationId ||
          !id(row.payload.userId) || !id(payload.userId) || String(row.payload.userId) !== String(payload.userId) ||
          money(row.payload.amount) === null || money(payload.amount) === null || money(row.payload.amount) !== money(payload.amount) ||
          row.payload.requestId !== (payload.requestId || null) ||
          !(resultType === 'refund_processed' ? ['refunded','failed'] : ['succeeded','failed']).includes(row.payload.status))) failures.push('GLOBAL_OUTBOX_ID_CONFLICT');
      for (const message of records.globalInbox.filter(row => row.event_id === resultId)) {
        if (service !== 'orders' || message.order_id !== payload.orderId || message.event_type !== resultType) failures.push('GLOBAL_INBOX_ID_CONFLICT');
      }
    }
    // Absence is normal for an unprocessed command; a committed owner inbox
    // or consumed result requires its atomically persisted owner result.
    const accepted = (sources.payments?.records.globalInbox || []).some(row => row.event_id === payload.eventId);
    const consumed = (sources.orders?.records.globalInbox || []).some(row => row.event_id === resultId);
    if ((accepted || consumed) && !(sources.payments?.records.globalOutbox || []).some(row => row.payload?.eventId === resultId)) failures.push('EXPECTED_RESULT_EVIDENCE_MISSING');
  }
  return [...new Set(failures)];
}
function verify(snapshot) {
  const checks = [];
  const check = (code, status, detail) => checks.push({ code, status, detail });
  const orders = snapshot.sources?.orders?.records;
  const payments = snapshot.sources?.payments?.records;
  const inventory = snapshot.sources?.inventory?.records;
  if (!orders || !payments || !inventory) {
    check('SNAPSHOT_INCOMPLETE', 'CONFLICT', 'All three database snapshots are required.');
    return { status: 'CONFLICT', checks };
  }
  for (const code of collisions(snapshot)) check(code, 'CONFLICT', 'Global event identity or lookup evidence conflicts.');
  check('CROSS_DATABASE_ATOMICITY', 'UNCERTAIN', 'Each source is repeatable-read; the three sources are not an atomic snapshot.');
  for (const [service, source] of Object.entries(snapshot.sources)) {
    check(`${service.toUpperCase()}_PAYLOAD_PRECISION`, [...(source.records.outbox || []), ...(source.records.globalOutbox || [])].some(row => row.payloadUnsafe) ? 'CONFLICT' : 'CONFIRMED', 'Unsafe persisted numeric precision is never rounded.');
    check(`${service.toUpperCase()}_SNAPSHOT_COMPLETE`, source.truncated ? 'CONFLICT' : 'CONFIRMED', 'Inspection is bounded to 1000 rows per collection.');
  }
  const order = orders.order?.length === 1 ? orders.order[0] : null;
  const saga = orders.saga?.length === 1 ? orders.saga[0] : null;
  check('ORDER_PRESENT', order && order.id === snapshot.orderId ? 'CONFIRMED' : 'CONFLICT', 'Exactly one requested order must exist.');
  check('SAGA_PRESENT', saga && saga.order_id === snapshot.orderId ? 'CONFIRMED' : 'CONFLICT', 'Exactly one requested Saga must exist.');
  if (!order || !saga) return { status: 'CONFLICT', checks };
  check('ORDER_FINANCIAL_FIELDS', id(order.user_id) && money(order.total_amount) > 0n ? 'CONFIRMED' : 'CONFLICT', 'Owner and positive amount must be valid.');
  check('SAGA_METADATA', STATES.has(saga.state) && Number.isInteger(saga.version) && saga.version > 0 &&
    Number.isInteger(saga.command_generation) && saga.command_generation >= 0 &&
    ['cancel_requested', 'payment_succeeded', 'refund_succeeded', 'inventory_inactive'].every(key => typeof saga[key] === 'boolean')
    ? 'CONFIRMED' : 'CONFLICT', 'Known state, version, generation and boolean compensation flags are required.');
  const paid = payments.payments || [];
  const refunds = payments.refunds || [];
  check('PAYMENT_UNIQUENESS', paid.length <= 1 ? 'CONFIRMED' : 'CONFLICT', 'At most one payment record may exist.');
  check('REFUND_UNIQUENESS', refunds.length <= 1 ? 'CONFIRMED' : 'CONFLICT', 'At most one refund record may exist.');
  check('FINANCIAL_RECORD_CORRELATION', [...paid, ...refunds].every(row => matchesFinancial(row, order)) ? 'CONFIRMED' : 'CONFLICT', 'Financial records must match the persisted order owner and amount.');
  check('FINANCIAL_STATUSES', paid.every(row => ['succeeded', 'failed'].includes(row.status)) && refunds.every(row => ['refunded', 'failed'].includes(row.status)) ? 'CONFIRMED' : 'CONFLICT', 'Unknown provider or simulator statuses require manual review.');
  const successfulPayment = paid.length === 1 && paid[0].status === 'succeeded' && matchesFinancial(paid[0], order);
  const successfulRefund = refunds.length === 1 && refunds[0].status === 'refunded' && matchesFinancial(refunds[0], order);
  check('REFUND_HAS_SUCCESSFUL_PAYMENT', !refunds.length || successfulPayment ? 'CONFIRMED' : 'CONFLICT', 'Any refund must belong to the successful original payment.');
  const paidState = ['PAYMENT_AUTHORIZED', 'CONFIRMED', 'REFUND_PENDING', 'REFUND_FAILED'].includes(saga.state);
  check('SAGA_PAYMENT_EVIDENCE', (!paidState || saga.payment_succeeded) && (!saga.payment_succeeded || successfulPayment) ? 'CONFIRMED' : 'CONFLICT', 'Paid states and flags require persisted payment success.');
  check('SUCCESSFUL_PAYMENT_FLAG', !successfulPayment || saga.state === 'STOCK_RESERVED' || saga.payment_succeeded ? 'CONFIRMED' : 'CONFLICT', 'Only an in-flight payment result may explain success before the Saga payment flag.');
  check('SAGA_REFUND_EVIDENCE', !saga.refund_succeeded || successfulRefund ? 'CONFIRMED' : 'CONFLICT', 'A refund flag requires persisted refund success.');
  check('REFUND_FLAG_STATE', !saga.refund_succeeded || ['RELEASE_PENDING', 'CANCELLED'].includes(saga.state) ? 'CONFIRMED' : 'CONFLICT', 'Completed refund flags belong to release or cancellation states.');
  if (saga.failure_state === 'PAYMENT_FAILED') check('PAYMENT_FAILURE_EVIDENCE', paid.length === 1 && paid[0].status === 'failed' ? 'CONFIRMED' : 'CONFLICT', 'A payment-failure path requires a persisted failed payment.');
  if (saga.state === 'REFUND_FAILED') check('REFUND_FAILURE_EVIDENCE', refunds.length === 1 && refunds[0].status === 'failed' ? 'CONFIRMED' : 'CONFLICT', 'Refund failure requires the owner failed refund record.');
  const reservations = inventory.reservations || [];
  const statusesValid = reservations.every(row => row.order_id === snapshot.orderId &&
    id(row.product_id) && Number.isInteger(row.quantity) && row.quantity > 0 &&
    ['PENDING', 'CONFIRMED', 'RELEASED', 'EXPIRED'].includes(row.status));
  check('RESERVATION_RECORDS', statusesValid && new Set(reservations.map(row => row.product_id)).size === reservations.length ? 'CONFIRMED' : 'CONFLICT', 'Reservation identities, quantities and statuses must be valid and unique.');
  check('RESERVATION_ORDER_ITEMS', reservations.every(row => Array.isArray(order.items) && order.items.some(item =>
    item.productId === row.product_id && item.quantity === row.quantity)) ? 'CONFIRMED' : 'CONFLICT', 'Observed reservations must match persisted order items.');
  const active = reservations.filter(row => ['PENDING', 'CONFIRMED'].includes(row.status));
  check('INVENTORY_TOMBSTONE', !(inventory.operation || []).some(row => row.closed === true) || active.length === 0 ? 'CONFIRMED' : 'CONFLICT', 'A closed Inventory operation must not retain active reservations.');
  check('INACTIVE_FLAG', !saga.inventory_inactive || active.length === 0 ? 'CONFIRMED' : 'CONFLICT', 'The inactive flag must not conflict with active reservations.');
  check('CURRENT_RESERVATION_ACTIVITY', reservations.length ? 'CONFIRMED' : 'UNCERTAIN', reservations.length
    ? `${active.length} active reservation(s) observed in the Inventory snapshot.` : 'No reservation exists; absence does not prove historical stock compensation.');
  check('STOCK_RESTORATION', 'UNCERTAIN', 'Absolute stock is diagnostic only; no immutable stock-movement ledger exists.');
  const releaseResults = (inventory.outbox || []).filter(row => row.event_type === 'inventory_released' &&
    row.payload?.orderId === snapshot.orderId && row.payload.allInactive === true && typeof row.payload.eventId === 'string');
  const consumed = (row, type) => (orders.inbox || []).some(message => message.order_id === snapshot.orderId && message.event_id === row.payload.eventId && message.event_type === type && message.processed_at);
  const history = orders.history || [];
  const allowed = { PENDING:['CANCEL_REQUESTED','STOCK_RESERVED','STOCK_FAILED'], CANCEL_REQUESTED:['RELEASE_PENDING','STOCK_FAILED'], STOCK_FAILED:['CANCELLED'], STOCK_RESERVED:['PAYMENT_AUTHORIZED','REFUND_PENDING','PAYMENT_FAILED'], PAYMENT_FAILED:['RELEASE_PENDING'], PAYMENT_AUTHORIZED:['CONFIRMED','REFUND_PENDING'], CONFIRMED:['REFUND_PENDING'], REFUND_PENDING:['REFUND_FAILED','RELEASE_PENDING'], REFUND_FAILED:['REFUND_PENDING'], RELEASE_PENDING:['CANCELLED'] };
  const continuous = history.every((row,index) => row.order_id === snapshot.orderId && allowed[row.from_state]?.includes(row.to_state) && (index === 0 || history[index-1].to_state === row.from_state));
  if (['CANCELLED','RELEASE_PENDING'].includes(saga.state)) check('COMPENSATION_HISTORY_CONTINUITY', continuous && history.length > 0 && history.at(-1).to_state === saga.state ? 'CONFIRMED' : 'CONFLICT', 'Ordered transition history must form a continuous chain ending at the observed Saga.');
  const transitioned = (row, from, to) => (orders.history || []).some((history,index) => history.order_id === snapshot.orderId && history.event_id === row.payload.eventId && history.from_state === from && history.to_state === to && (to !== 'CANCELLED' || index === orders.history.length - 1) && (to !== 'RELEASE_PENDING' || saga.state !== 'RELEASE_PENDING' || index === orders.history.length - 1) && (to !== 'RELEASE_PENDING' || saga.state !== 'CANCELLED' || index === orders.history.length - 2 && orders.history[index+1].from_state === 'RELEASE_PENDING' && orders.history[index+1].to_state === 'CANCELLED'));
  const consumedRelease = releaseResults.some(row => consumed(row,'inventory_released') && transitioned(row,'RELEASE_PENDING','CANCELLED'));
  const refundLineage = (payments.outbox || []).some(row => row.event_type === 'refund_processed' && row.payload?.orderId === snapshot.orderId && row.payload.status === 'refunded' && row.payload.operationId === `${snapshot.orderId}:refund_requested` && id(row.payload.userId) && String(row.payload.userId) === String(order.user_id) && money(row.payload.amount) !== null && money(row.payload.amount) === money(order.total_amount) && consumed(row,'refund_processed') && transitioned(row,'REFUND_PENDING','RELEASE_PENDING'));
  if (saga.refund_succeeded) check('REFUND_COMPENSATION_LINEAGE', refundLineage ? 'CONFIRMED' : 'CONFLICT', 'Require correlated owner refund result, consumed inbox and release transition.');
  if (saga.state === 'CANCELLED') {
    check('CANCELLED_ORDER_STATUS', order.status === 'cancelled' ? 'CONFIRMED' : 'CONFLICT', 'Cancelled Saga must match the order status.');
    check('CANCELLED_FINANCIAL_COMPENSATION', !successfulPayment || (successfulRefund && saga.refund_succeeded) ? 'CONFIRMED' : 'CONFLICT', 'Successful payment requires a verified successful refund before cancellation.');
    const noReservationFailure = saga.failure_state === 'STOCK_FAILED' && !successfulPayment && reservations.length === 0 && (inventory.outbox || []).some(row => row.event_type === 'inventory_reservation_failed' && row.payload?.orderId === snapshot.orderId && consumed(row,'inventory_reservation_failed') && transitioned(row,'STOCK_FAILED','CANCELLED') && history.length >= 2 && history.at(-2).event_id === row.payload.eventId && ['PENDING','CANCEL_REQUESTED'].includes(history.at(-2).from_state) && history.at(-2).to_state === 'STOCK_FAILED');
    check('CANCELLED_INVENTORY_COMPENSATION', active.length === 0 && (noReservationFailure || (saga.inventory_inactive && consumedRelease)) ? 'CONFIRMED' : 'CONFLICT', 'Require consumed owner release evidence, or the stock-failure path with no reservation.');
  }
  if (saga.state === 'CONFIRMED') check('CONFIRMED_RESERVATIONS', Array.isArray(order.items) && order.items.length > 0 && new Set(order.items.map(item => item.productId)).size === order.items.length && reservations.length === order.items.length && order.items.every(item => id(item.productId) && Number.isInteger(item.quantity) && item.quantity > 0 && reservations.some(row => row.product_id === item.productId && row.quantity === item.quantity && row.status === 'CONFIRMED')) ? 'CONFIRMED' : 'CONFLICT', 'Confirmed purchase requires confirmed Inventory reservations.');
  const statuses = { REFUND_PENDING: 'refund_pending', REFUND_FAILED: 'refund_failed', CONFIRMED: 'succeeded' };
  if (statuses[saga.state]) check('ORDER_SAGA_STATUS', order.status === statuses[saga.state] ? 'CONFIRMED' : 'CONFLICT', 'Order status must agree with its Saga state.');
  return { status: checks.some(row => row.status === 'CONFLICT') ? 'CONFLICT' : 'CONSISTENT_WITH_LIMITATIONS', checks };
}

module.exports = { verify, money, matchesFinancial, id };
