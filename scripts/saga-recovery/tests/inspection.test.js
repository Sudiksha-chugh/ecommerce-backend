'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile, validateProfile, validateOrderId } = require('../config');
const { inspect, publicInspection, IDENTITY_SQL, defaultClient } = require('../inspect');
const { plan, fingerprint } = require('../plan');
const { verify } = require('../verify');
const { main, parseArguments } = require('../cli');

async function cleanupAttempt(failures, action) { try { await action(); } catch(error) { failures.push(error); } }

const date = '2026-01-01T00:00:00';
function profile() {
  const ports = { orders: 55435, payments: 55436, inventory: 55437 };
  return { environment: 'isolated-test', kind: 'isolated-test', databases: Object.fromEntries(
    Object.entries(ports).map(([service, port]) => [service, { host: '127.0.0.1', port,
      database: `${service}_phase21_test`, user: `${service}_app`, password: 'synthetic-test-only-secret',
      expectedDatabaseOid: '12345', expectedServerPort: 5432 }])) };
}
function fixture(type = 'refund_requested') {
  const release = type === 'inventory_release_requested';
  const command = { id: 9, event_type: type, published: true, created_at: date, published_at: date,
    payload: { orderId: 77, eventId: `77:${type}:3`, operationId: `77:${type}`, userId: 22,
      amount: '20.00', items: [{ productId: 1, quantity: 2 }], requestId: 'synthetic-request', attempt: 3 } };
  const snapshot = { formatVersion: 1, environment: 'isolated-test', environmentKind: 'isolated-test', orderId: 77,
    crossDatabaseSnapshot: 'NON_ATOMIC', sources: {} };
  for (const service of ['orders', 'payments', 'inventory']) snapshot.sources[service] = {
    identity: { database: `${service}_phase21_test`, role: `${service}_app`, databaseOid: '12345', serverPort: 5432, readOnly: true },
    observedAt: date, truncated: false, records: { outbox: [], inbox: [] } };
  Object.assign(snapshot.sources.orders.records, {
    order: [{ id: 77, user_id: 22, total_amount: '20.00', items: command.payload.items, status: 'refund_pending', created_at: date }],
    saga: [{ order_id: 77, state: release ? 'RELEASE_PENDING' : 'REFUND_PENDING', version: 7, command_generation: 3,
      cancel_requested: true, payment_succeeded: true, refund_succeeded: release, inventory_inactive: true,
      failure_state: null, created_at: date, updated_at: date, has_error: false }],
    outbox: [command], history: [{ id: 4, order_id: 77, event_id: 'expiration-result',
      from_state: release ? 'REFUND_PENDING' : 'PAYMENT_AUTHORIZED', to_state: release ? 'RELEASE_PENDING' : 'REFUND_PENDING', created_at: date }],
  });
  Object.assign(snapshot.sources.payments.records, {
    payments: [{ id: 1, order_id: 77, user_id: 22, amount: '20.00', status: 'succeeded', created_at: date, updated_at: date }],
    refunds: release ? [{ id: 2, order_id: 77, user_id: 22, amount: '20.00', status: 'refunded', created_at: date, updated_at: date }] : [],
  });
  Object.assign(snapshot.sources.inventory.records, {
    reservations: [{ id: 1, order_id: 77, product_id: 1, quantity: 2, status: 'EXPIRED', created_at: date, expires_at: date }],
    stock: [{ product_id: 1, quantity: 10, updated_at: date }], operation: [],
  });
  command.payloadText = JSON.stringify(command.payload);
  for (const source of Object.values(snapshot.sources)) { source.records.globalInbox = source.records.inbox; source.records.globalOutbox = source.records.outbox; }
  if (release) {
    const result = { event_type: 'refund_processed', payload: { orderId: 77, eventId: 'refund-success', operationId: '77:refund_requested', userId: 22, amount: '20.00', status: 'refunded' } };
    snapshot.sources.payments.records.outbox.push(result);
    snapshot.sources.orders.records.inbox.push({ order_id: 77, event_id: 'refund-success', event_type: 'refund_processed', processed_at: date });
    snapshot.sources.orders.records.history[0].event_id = 'refund-success';
  }
  return snapshot;
}

test('CLI requires explicit environment and order; unsupported execution and duplicate options are rejected', () => {
  for (const args of [[], ['execute'], ['inspect', '--order-id', '77'], ['inspect', '--environment', 'local'],
    ['inspect', '--environment', 'local', '--order-id', '77', '--environment', 'other'],
    ['inspect', '--environment', 'local', '--order-id', '77', '--output', 'artifact.json']]) assert.throws(() => parseArguments(args));
  for (const value of ['0', '-1', '1.0', '1e2', '2147483648', '01', undefined]) assert.throws(() => validateOrderId(value));
  assert.equal(validateOrderId('56'), 56);
});
test('invalid, remote, privileged, ambiguous and missing target configurations fail closed', () => {
  const validate = value => validateProfile(value.environment, { kind: value.kind, databases: value.databases });
  assert.equal(validate(profile()).environment, 'isolated-test');
  assert.throws(() => validateProfile('../local', { kind: profile().kind, databases: profile().databases }));
  for (const mutate of [p => { p.databases.orders = undefined; }, p => { p.kind = 'production'; },
    p => { p.databases.orders.host = 'localhost'; }, p => { p.databases.orders.user = 'postgres'; },
    p => { p.databases.orders.expectedDatabaseOid = ''; }, p => { p.databases.orders.expectedDatabaseOid = '4294967296'; },
    p => { p.databases.orders.password = ''; }, p => { p.databases.payments.database = p.databases.orders.database; },
    p => { p.databases.orders.database = 'orders_db'; }, p => { p.databases.orders.ssl = false; }]) {
    const value = profile(); mutate(value); assert.throws(() => validate(value));
  }
});
test('configuration never falls back to .env; owner-only explicit file and profile are required', () => {
  assert.throws(() => loadProfile('local', ''), /EXPLICIT_CONFIG_PATH_REQUIRED/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-recovery-config-test-'));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, 'profile.json');
  const value = profile();
  fs.writeFileSync(filename, JSON.stringify({ version: 1, profiles: { local: { kind: value.kind, databases: value.databases } } }), { mode: 0o600 });
  assert.equal(loadProfile('local', filename).environment, 'local');
  assert.throws(() => loadProfile('missing', filename), /UNKNOWN_ENVIRONMENT/);
  fs.chmodSync(filename, 0o644);
  assert.throws(() => loadProfile('local', filename), /UNSAFE_CONFIG_FILE/);
  fs.chmodSync(filename, 0o600);
  const link = path.join(directory, 'link.json'); fs.symlinkSync(filename, link);
  assert.throws(() => loadProfile('local', link), /UNSAFE_CONFIG_FILE/);
  fs.unlinkSync(link); fs.unlinkSync(filename); fs.rmdirSync(directory);
});
test('existing refund and release commands produce review artifacts preserving exact payloads', () => {
  for (const type of ['refund_requested', 'inventory_release_requested']) {
    const value = fixture(type); const before = structuredClone(value);
    const result = plan(value, 'replay-existing');
    assert.equal(result.status, 'REVIEW_REQUIRED'); assert.deepEqual(result.command, before.sources.orders.records.outbox[0]);
    assert.equal(result.executionSupported, false); assert.equal(result.persisted, false); assert.deepEqual(value, before);
    assert.match(result.planFingerprint, /^[a-f0-9]{64}$/);
  }
});
test('unpublished commands are reported as already eligible for owner outbox retry', () => {
  const value = fixture(); value.sources.orders.records.outbox[0].published = false;
  assert.match(plan(value, 'replay-existing').publicationDisposition, /OWNER_POLLER_MAY_RETRY/);
});
test('failed-payment release is supported without requiring a cancellation flag', () => {
  const value = fixture('inventory_release_requested'); const saga = value.sources.orders.records.saga[0];
  Object.assign(saga, { payment_succeeded: false, refund_succeeded: false, cancel_requested: false, failure_state: 'PAYMENT_FAILED' });
  value.sources.payments.records.payments[0].status = 'failed'; value.sources.payments.records.refunds = [];
  assert.equal(plan(value, 'replay-existing').status, 'REVIEW_REQUIRED');
});
for (const [name, mutate] of [
  ['missing order', s => { s.sources.orders.records.order = []; }],
  ['missing Saga', s => { s.sources.orders.records.saga = []; }],
  ['missing payment', s => { s.sources.payments.records.payments = []; }],
  ['failed original payment', s => { s.sources.payments.records.payments[0].status = 'failed'; }],
  ['conflicting financial owner', s => { s.sources.payments.records.payments[0].user_id = 99; }],
  ['conflicting financial amount', s => { s.sources.payments.records.payments[0].amount = '21.00'; }],
  ['duplicate payments', s => { s.sources.payments.records.payments.push(s.sources.payments.records.payments[0]); }],
  ['duplicate successful refunds', s => { s.sources.payments.records.refunds = [1, 2].map(id => ({ id, order_id: 77, user_id: 22, amount: '20.00', status: 'refunded' })); }],
  ['missing command', s => { s.sources.orders.records.outbox = []; }],
  ['stale command generation', s => { s.sources.orders.records.outbox[0].payload.attempt = 2; }],
  ['missing request ID', s => { delete s.sources.orders.records.outbox[0].payload.requestId; }],
  ['conflicting operation identity', s => { s.sources.orders.records.outbox[0].payload.operationId = 'other'; }],
  ['missing event identity', s => { delete s.sources.orders.records.outbox[0].payload.eventId; }],
  ['invalid publication timestamp', s => { s.sources.orders.records.outbox[0].published_at = null; }],
  ['conflicting command amount', s => { s.sources.orders.records.outbox[0].payload.amount = '21.00'; }],
  ['unsupported secret payload field', s => { s.sources.orders.records.outbox[0].payload.token = 'must-not-print'; }],
  ['ambiguous current command', s => { s.sources.orders.records.outbox.push(structuredClone(s.sources.orders.records.outbox[0])); }],
  ['incomplete history', s => { s.sources.orders.records.history = []; }],
  ['incomplete snapshot', s => { s.sources.inventory.truncated = true; }],
  ['reservation quantity mismatch', s => { s.sources.inventory.records.reservations[0].quantity = 3; }],
  ['inactive flag with active reservation', s => { s.sources.inventory.records.reservations[0].status = 'PENDING'; }],
]) test(`planning blocks ${name}`, () => {
  const value = fixture(); mutate(value); const result = plan(value, 'replay-existing');
  assert.equal(result.status, 'BLOCKED'); assert.ok(result.blockers.length); assert.equal(result.command, undefined);
  assert.equal(result.planFingerprint, undefined);
});
test('unsupported actions and terminal, failed or purchase states never produce a replay plan', () => {
  assert.ok(plan(fixture(), 'refund-again').blockers.includes('UNSUPPORTED_ACTION'));
  for (const state of ['PENDING', 'CONFIRMED', 'CANCELLED', 'REFUND_FAILED']) {
    const value = fixture(); value.sources.orders.records.saga[0].state = state;
    assert.equal(plan(value, 'replay-existing').status, 'BLOCKED');
  }
});
test('another unresolved command prevents an ambiguous refund replay', () => {
  const value = fixture(); const old = structuredClone(value.sources.orders.records.outbox[0]);
  old.id = 8; old.payload.attempt = 2; old.payload.eventId = 'older-refund'; old.payloadText = JSON.stringify(old.payload); value.sources.orders.records.outbox.unshift(old);
  assert.ok(plan(value, 'replay-existing').blockers.includes('OTHER_UNRESOLVED_COMMAND'));
});
test('processed successful refund can republish its exact persisted result; failed/missing results cannot', () => {
  const value = fixture(); const command = value.sources.orders.records.outbox[0].payload;
  value.sources.payments.records.inbox.push({ event_id: command.eventId, event_type: 'refund_requested', order_id: 77, processed_at: date });
  value.sources.payments.records.refunds.push({ id: 2, order_id: 77, user_id: 22, amount: '20.00', status: 'refunded' });
  value.sources.payments.records.outbox.push({ id: 2, event_type: 'refund_processed', published: true,
    payload: { ...command, eventId: `${command.eventId}:result`, status: 'refunded' } });
  assert.equal(plan(value, 'replay-existing').status, 'REVIEW_REQUIRED');
  const failed = structuredClone(value); failed.sources.payments.records.outbox[0].payload.status = 'failed';
  assert.ok(plan(failed, 'replay-existing').blockers.includes('PROCESSED_REFUND_NOT_REPLAYABLE_AS_SUCCESS'));
  const consumed = structuredClone(value); consumed.sources.orders.records.inbox.push({ event_id: `${command.eventId}:result`, order_id:77, event_type:'refund_processed', processed_at: date });
  assert.ok(plan(consumed, 'replay-existing').blockers.includes('RESULT_ALREADY_CONSUMED_BUT_SAGA_PENDING'));
  value.sources.payments.records.outbox = [];
  assert.equal(plan(value, 'replay-existing').status, 'BLOCKED');
});
test('processed Inventory release is blocked until command/result correlation is implemented', () => {
  const value = fixture('inventory_release_requested');
  value.sources.inventory.records.inbox.push({ event_id: value.sources.orders.records.outbox[0].payload.eventId, order_id: 77 });
  assert.ok(plan(value, 'replay-existing').blockers.includes('INVENTORY_DUPLICATE_RESULT_CORRELATION_UNSUPPORTED'));
});
test('fingerprints are deterministic across key ordering and observation times, and detect changed evidence', () => {
  const value = fixture(); const original = plan(value, 'replay-existing');
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  const reordered = structuredClone(value);
  const payload = reordered.sources.orders.records.outbox[0].payload;
  reordered.sources.orders.records.outbox[0].payload = Object.fromEntries(Object.entries(payload).reverse());
  assert.equal(plan(reordered, 'replay-existing').planFingerprint, original.planFingerprint);
  const later = structuredClone(value); later.sources.orders.observedAt = '2027-01-01';
  later.sources.inventory.records.stock[0].quantity = 7;
  assert.equal(plan(later, 'replay-existing').planFingerprint, original.planFingerprint);
  later.sources.orders.records.saga[0].version++;
  assert.notEqual(plan(later, 'replay-existing').planFingerprint, original.planFingerprint);
  const changed = structuredClone(value); changed.sources.orders.records.outbox[0].payload.requestId = 'other-request'; changed.sources.orders.records.outbox[0].payloadText = JSON.stringify(changed.sources.orders.records.outbox[0].payload);
  assert.notEqual(plan(changed, 'replay-existing').commandFingerprint, original.commandFingerprint);
});
test('verification distinguishes compensation evidence from absolute stock and missing records', () => {
  const value = fixture('inventory_release_requested'); const saga = value.sources.orders.records.saga[0];
  saga.state = 'CANCELLED'; value.sources.orders.records.order[0].status = 'cancelled';
  assert.equal(verify(value).status, 'CONFLICT');
  value.sources.inventory.records.outbox.push({ event_type: 'inventory_released', payload: { orderId: 77, eventId: 'released', allInactive: true } });
  value.sources.orders.records.history.push({ order_id: 77, event_id: 'released', from_state: 'RELEASE_PENDING', to_state: 'CANCELLED' });
  value.sources.orders.records.inbox.push({ order_id: 77, event_id: 'released', event_type: 'inventory_released', processed_at: date });
  const result = verify(value); assert.equal(result.status, 'CONSISTENT_WITH_LIMITATIONS');
  assert.equal(result.checks.find(check => check.code === 'STOCK_RESTORATION').status, 'UNCERTAIN');
  value.sources.inventory.records.stock[0].quantity = 100;
  assert.equal(verify(value).status, 'CONSISTENT_WITH_LIMITATIONS');
});
test('inspection output redacts arbitrary secrets, provider IDs, free-form errors and extra item fields', () => {
  const value = fixture(); value.sources.orders.records.outbox[0].payload.token = 'must-not-print';
  value.sources.orders.records.outbox[0].payload.items[0].email = 'private@example.invalid';
  const output = JSON.stringify(publicInspection(value));
  assert.ok(!output.includes('must-not-print')); assert.ok(!output.includes('private@example.invalid'));
  assert.ok(output.includes('redactedFields'));
  value.sources.orders.records.outbox[0].payload.items[0].productId = { password: 'nested-secret' };
  assert.ok(!JSON.stringify(publicInspection(value)).includes('nested-secret'));
});

test('global inbox collisions with another order or event type block planning', () => {
  for (const change of [{ order_id: 78, event_type: 'refund_requested' }, { order_id: 77, event_type: 'payment_requested' }]) {
    const value = fixture();
    value.sources.payments.records.globalInbox = [{ event_id: value.sources.orders.records.outbox[0].payload.eventId, ...change }];
    assert.ok(plan(value,'replay-existing').blockers.includes('GLOBAL_INBOX_ID_CONFLICT'));
  }
});
test('global result collisions and conflicting command bodies block planning', () => {
  for (const modify of [p => { p.orderId = 78; }, p => { p.operationId = 'other'; }, p => { p.amount = '21.00'; }]) {
    const value = fixture(); const payload = { ...value.sources.orders.records.outbox[0].payload, eventId: '77:refund_requested:3:result', status: 'refunded' };
    modify(payload); value.sources.payments.records.globalOutbox = [{ event_type:'refund_processed',payload,payloadText:JSON.stringify(payload) }];
    assert.ok(plan(value,'replay-existing').blockers.includes('GLOBAL_OUTBOX_ID_CONFLICT'));
  }
  const value = fixture(); const other = structuredClone(value.sources.orders.records.outbox[0]); other.payload.requestId='conflicting'; other.payloadText=JSON.stringify(other.payload);
  value.sources.payments.records.globalOutbox=[other];
  assert.ok(plan(value,'replay-existing').blockers.includes('GLOBAL_OUTBOX_ID_CONFLICT'));
});
test('exact JSON decoder rejects precision loss and preserves quoted identifiers', () => {
  const {parseExactJSON}=require('../inspect');
  for(const text of ['{"amount":20.0000000000000001}','{"amount":20.0000000000000002}','{"quantity":9007199254740993}','{"amount":1e999}']) assert.throws(()=>parseExactJSON(text),/UNSUPPORTED_JSON_PRECISION/);
  assert.deepEqual(parseExactJSON('{"amount":"20.0000000000000001","quantity":2,"requestId":"9007199254740993"}'),{amount:'20.0000000000000001',quantity:2,requestId:'9007199254740993'});
  const value=fixture();value.sources.orders.records.outbox[0].payloadUnsafe=true;
  assert.equal(plan(value,'replay-existing').status,'BLOCKED');
});
test('precision loss outside command payloads fails closed with a sanitized blocked CLI response',async()=>{
  const output=[];
  const code=await main(['plan','--environment','isolated-test','--order-id','77','--action','replay-existing'],{loadProfile:profile,inspect:async()=>{const error=new Error('private raw value');error.code='UNSUPPORTED_JSON_PRECISION';throw error;},output:value=>output.push(value)});
  assert.equal(code,2);assert.equal(output[0].status,'BLOCKED');assert.ok(!JSON.stringify(output).includes('private raw value'));
});
test('malformed scalar identifiers and financial amounts never pass coercion',()=>{
  const {money,id}=require('../verify');
  for(const malformed of [[22],{value:22},null,true,false]) {assert.equal(id(malformed),false);assert.equal(money(malformed),null);}
  for(const field of ['userId','amount'])for(const malformed of [[22],{value:22},null,true,false,'1e1',Infinity]){
    const value=fixture();value.sources.orders.records.outbox[0].payload[field]=malformed;
    value.sources.orders.records.outbox[0].payloadText=JSON.stringify(value.sources.orders.records.outbox[0].payload);
    assert.equal(plan(value,'replay-existing').status,'BLOCKED');
  }
});
test('confirmed orders require complete bidirectional multi-product reservations',()=>{
  const value=fixture();const saga=value.sources.orders.records.saga[0];saga.state='CONFIRMED';saga.inventory_inactive=false;
  value.sources.orders.records.order[0].status='succeeded';value.sources.orders.records.order[0].items=[{productId:1,quantity:2},{productId:2,quantity:3}];
  value.sources.inventory.records.reservations[0].status='CONFIRMED';
  assert.equal(verify(value).status,'CONFLICT');
  value.sources.inventory.records.reservations.push({order_id:77,product_id:2,quantity:3,status:'CONFIRMED'});
  assert.equal(verify(value).status,'CONSISTENT_WITH_LIMITATIONS');
  value.sources.orders.records.order[0].items.push({productId:2,quantity:3});assert.equal(verify(value).status,'CONFLICT');
});
test('release eligibility requires refund result and transition lineage',()=>{
  for(const mutate of [s=>{s.sources.payments.records.outbox=[];},s=>{s.sources.orders.records.inbox=[];},s=>{s.sources.orders.records.history[0].event_id='unrelated';}]){
    const value=fixture('inventory_release_requested');mutate(value);
    assert.ok(plan(value,'replay-existing').blockers.includes('REFUND_COMPENSATION_LINEAGE'));
  }
});
test('stock failure cancellation requires actual owner failure and both transitions',()=>{
  const value=fixture();const saga=value.sources.orders.records.saga[0];Object.assign(saga,{state:'CANCELLED',failure_state:'STOCK_FAILED',payment_succeeded:false,inventory_inactive:false});
  value.sources.orders.records.order[0].status='cancelled';value.sources.payments.records.payments=[];value.sources.inventory.records.reservations=[];
  assert.equal(verify(value).status,'CONFLICT');
  value.sources.inventory.records.outbox.push({event_type:'inventory_reservation_failed',payload:{eventId:'stock-failure',orderId:77}});
  value.sources.orders.records.inbox.push({event_id:'stock-failure',order_id:77,event_type:'inventory_reservation_failed',processed_at:date});
  value.sources.orders.records.history=[];
  value.sources.orders.records.history.push({order_id:77,event_id:'stock-failure',from_state:'PENDING',to_state:'STOCK_FAILED'},{order_id:77,event_id:'stock-failure',from_state:'STOCK_FAILED',to_state:'CANCELLED'});
  assert.equal(verify(value).status,'CONSISTENT_WITH_LIMITATIONS');
});
test('endpoint changes alter evidence fingerprints without including credentials',()=>{
  const value=fixture();value.sources.orders.identity.host='127.0.0.1';value.sources.orders.identity.connectionPort=55435;
  const original=plan(value,'replay-existing');value.sources.orders.identity.connectionPort=55439;
  assert.notEqual(plan(value,'replay-existing').evidenceFingerprint,original.evidenceFingerprint);
  assert.ok(!JSON.stringify(original).includes('synthetic-test-only-secret'));
});

function terminalFixture(paid = true) {
  const value=fixture('inventory_release_requested');
  const orders=value.sources.orders.records;
  orders.saga[0].state='CANCELLED';orders.order[0].status='cancelled';
  const result={event_type:'inventory_released',payload:{orderId:77,eventId:'94055a64-5aa0-4a45-bbca-2feabc83d8d6',allInactive:true}};
  value.sources.inventory.records.outbox.push(result);
  orders.inbox.push({order_id:77,event_id:result.payload.eventId,event_type:result.event_type,processed_at:date});
  if (!paid) {
    Object.assign(orders.saga[0],{payment_succeeded:false,refund_succeeded:false});
    value.sources.payments.records.payments=[];value.sources.payments.records.refunds=[];value.sources.payments.records.outbox.length=0;
    orders.history=[{order_id:77,event_id:'reserved',from_state:'CANCEL_REQUESTED',to_state:'RELEASE_PENDING'}];
  }
  orders.history.push({order_id:77,event_id:result.payload.eventId,from_state:'RELEASE_PENDING',to_state:'CANCELLED'});
  return value;
}
test('terminal verification rejects cross-order Inventory UUID and Payments result collisions',()=>{
  for(const service of ['inventory','payments']){
    const value=terminalFixture();assert.equal(verify(value).status,'CONSISTENT_WITH_LIMITATIONS');
    const conflict=structuredClone(value.sources[service].records.outbox[0]);conflict.payload.orderId=78;
    value.sources[service].records.globalOutbox=[...value.sources[service].records.outbox,conflict];
    assert.equal(verify(value).status,'CONFLICT');assert.equal(plan(value,'replay-existing').status,'BLOCKED');
  }
});
test('exact owner UUIDs are requested globally and omitted lookup coverage fails closed',async()=>{
  const value=terminalFixture();const calls=[];const result=await inspect(profile(),77,{clientFactory:fakeFactory(value,calls)});
  assert.equal(verify(result).status,'CONSISTENT_WITH_LIMITATIONS');
  const uuid=value.sources.inventory.records.outbox[0].payload.eventId;
  assert.equal(calls.filter(call=>call.sql.includes('event_id=ANY')&&call.values[0].includes(uuid)).length,3);
  result.sources.orders.records.globalEventIds=[];assert.equal(verify(result).status,'CONFLICT');
});
test('disconnected, reordered and contradictory compensation histories fail closed',()=>{
  for(const mutate of [h=>h.splice(1,0,{order_id:77,event_id:'bad',from_state:'RELEASE_PENDING',to_state:'REFUND_FAILED'}),h=>h.reverse(),h=>{h[0].from_state='CONFIRMED';},h=>h.splice(0,1)]){
    const value=terminalFixture();mutate(value.sources.orders.records.history);assert.equal(verify(value).status,'CONFLICT');
  }
});
test('legitimate unpaid cancellation retains a continuous release lineage',()=>{
  assert.equal(verify(terminalFixture(false)).status,'CONSISTENT_WITH_LIMITATIONS');
});
test('stock failure rejects invalid predecessors and intervening transitions',()=>{
  for(const predecessor of ['CONFIRMED','RELEASE_PENDING','REFUND_PENDING']){
    const value=terminalFixture(false);value.sources.inventory.records.reservations=[];value.sources.orders.records.saga[0].failure_state='STOCK_FAILED';
    const result=value.sources.inventory.records.outbox[0];result.event_type='inventory_reservation_failed';delete result.payload.allInactive;
    value.sources.orders.records.inbox[0]={order_id:77,event_id:result.payload.eventId,event_type:result.event_type,processed_at:date};
    value.sources.orders.records.history=[{order_id:77,event_id:result.payload.eventId,from_state:predecessor,to_state:'STOCK_FAILED'},{order_id:77,event_id:result.payload.eventId,from_state:'STOCK_FAILED',to_state:'CANCELLED'}];
    assert.equal(verify(value).status,'CONFLICT');
  }
});
test('cleanup failures accumulate while remaining service cleanup and closure proceed',async()=>{
  const failures=[],calls=[];
  for(const service of ['orders','payments','inventory']){
    await cleanupAttempt(failures,async()=>{calls.push(service);if(service==='orders')throw new Error('synthetic cleanup failure');});
    await cleanupAttempt(failures,async()=>{calls.push(`${service}:closed`);});
  }
  assert.equal(failures.length,1);assert.deepEqual(calls,['orders','orders:closed','payments','payments:closed','inventory','inventory:closed']);
});

test('stock failure permits both actual predecessors but rejects intervening history',()=>{
  for(const predecessor of ['PENDING','CANCEL_REQUESTED']){
    const value=terminalFixture(false);const orders=value.sources.orders.records;
    value.sources.inventory.records.reservations=[];orders.saga[0].failure_state='STOCK_FAILED';
    const result=value.sources.inventory.records.outbox[0];result.event_type='inventory_reservation_failed';delete result.payload.allInactive;
    orders.inbox=[{order_id:77,event_id:result.payload.eventId,event_type:result.event_type,processed_at:date}];orders.globalInbox=orders.inbox;
    orders.history=[{order_id:77,event_id:result.payload.eventId,from_state:predecessor,to_state:'STOCK_FAILED'},{order_id:77,event_id:result.payload.eventId,from_state:'STOCK_FAILED',to_state:'CANCELLED'}];
    assert.equal(verify(value).status,'CONSISTENT_WITH_LIMITATIONS');
    orders.history.splice(1,0,{order_id:77,event_id:'intervening',from_state:'STOCK_FAILED',to_state:'CANCEL_REQUESTED'});
    assert.equal(verify(value).status,'CONFLICT');
  }
});
test('partial query and rollback failures close every acquired connection without masking query failure',async()=>{
  const calls=[];const factory=fakeFactory(fixture(),calls);
  const failing=(spec,service)=>{
    const client=factory(spec,service);const query=client.query.bind(client);
    client.query=async(sql,values)=>{
      if(service==='inventory'&&sql.includes('event_id=ANY'))throw new Error('original synthetic query failure');
      if(service==='orders'&&sql==='ROLLBACK')throw new Error('synthetic rollback failure');
      return query(sql,values);
    };return client;
  };
  await assert.rejects(inspect(profile(),77,{clientFactory:failing}),/original synthetic query failure/);
  for(const service of ['orders','payments','inventory'])assert.equal(calls.filter(call=>call.service===service&&call.sql==='END').length,1);
});

test('global-only expected Payments results cannot escape command correlation',()=>{
  for(const change of [{orderId:78},{operationId:'78:refund_requested'},{amount:'21.00'},{userId:23},{requestId:'wrong' }]){
    const value=fixture();const command=value.sources.orders.records.outbox[0].payload;
    value.sources.payments.records.globalOutbox=[{event_type:'refund_processed',payload:{...command,eventId:`${command.eventId}:result`,status:'refunded',...change}}];
    assert.equal(verify(value).status,'CONFLICT');assert.equal(plan(value,'replay-existing').status,'BLOCKED');
  }
});
test('earlier expected refund collision is not hidden by terminal later success',()=>{
  const value=terminalFixture();const command=fixture().sources.orders.records.outbox[0];
  value.sources.orders.records.outbox.push(command);
  value.sources.payments.records.globalOutbox=[...value.sources.payments.records.outbox,{event_type:'refund_processed',payload:{...command.payload,eventId:`${command.payload.eventId}:result`,orderId:78,status:'refunded'}}];
  assert.equal(verify(value).status,'CONFLICT');
});
test('missing pending results are legitimate; accepted commands require owner results',()=>{
  const value=fixture();assert.equal(verify(value).status,'CONSISTENT_WITH_LIMITATIONS');
  const command=value.sources.orders.records.outbox[0].payload;
  value.sources.payments.records.inbox.push({event_id:command.eventId,event_type:'refund_requested',order_id:77});
  assert.ok(verify(value).checks.some(check=>check.code==='EXPECTED_RESULT_EVIDENCE_MISSING'));
});

test('partial fixture setup preserves original failure while cleanup restores environment and closes all services',async()=>{
  const key='SAGA_RECOVERY_SYNTHETIC_FIXTURE_TEST',saved=process.env[key];
  const original=new Error('synthetic setup failure'),failures=[],closed=[],removed=[];let preserved;
  try {
    process.env[key]='temporary';
    try { throw original; } catch(error) { preserved=error; }
    finally {
      try {
        for(const service of ['orders','inventory','payments']){
          try { await cleanupAttempt(failures,async()=>{removed.push(service);if(service==='orders')throw new Error('synthetic cleanup failure');}); }
          finally { await cleanupAttempt(failures,async()=>closed.push(service)); }
        }
      } finally { if(saved===undefined)delete process.env[key];else process.env[key]=saved; }
    }
    assert.equal(preserved,original);assert.equal(failures.length,1);
    assert.deepEqual(removed,['orders','inventory','payments']);assert.deepEqual(closed,removed);assert.equal(process.env[key],saved);
  } finally { if(saved===undefined)delete process.env[key];else process.env[key]=saved; }
});

function fakeFactory(snapshot, calls, changeIdentity = () => {}) {
  return (spec, service) => ({
    async connect() { calls.push({ service, sql: 'CONNECT' }); },
    async end() { calls.push({ service, sql: 'END' }); },
    async query(sql, values) {
      calls.push({ service, sql, values });
      if (sql === IDENTITY_SQL) {
        const identity = { database: spec.database, role: spec.user, database_oid: spec.expectedDatabaseOid,
          server_port: 5432, read_only: 'on', isolation: 'repeatable read', privileged: false, database_owner: false, owns_relations: false };
        Object.assign(identity, { can_create: false, mutating_privileges: false });
        changeIdentity(identity); return { rows: [identity] };
      }
      if (sql.startsWith('SELECT transaction_timestamp')) return { rows: [{ observed_at: date }] };
      if (sql.includes('event_id=ANY')) return { rows: snapshot.sources[service].records.globalInbox.filter(record => values[0].includes(record.event_id)).map(record => ({ record })) };
      if (sql.includes("payload->>'eventId'=ANY")) return { rows: snapshot.sources[service].records.globalOutbox.filter(record => values[0].includes(record.payload?.eventId)).map(record => ({ record: { ...record }, payload_text: record.payloadText || JSON.stringify(record.payload) })) };
      if (sql.startsWith('SELECT to_jsonb')) {
        const table = sql.match(/FROM public\.(\w+)/)[1];
        const names = { orders: 'order', order_sagas: 'saga', saga_transitions: 'history', outbox_events: 'outbox',
          inbox_events: 'inbox', inventory_order_operations: 'operation', inventory: 'stock' };
        return { rows: (snapshot.sources[service].records[names[table] || table] || []).map(record => ({ record, ...(table === 'outbox_events' ? { payload_text: record.payloadText || JSON.stringify(record.payload) } : {}) })) };
      }
      return { rows: [] };
    },
  });
}
test('all inspection SQL is read-only, identity precedes business reads, and all transactions roll back', async () => {
  const calls = []; const value = await inspect(profile(), 77, { clientFactory: fakeFactory(fixture(), calls) });
  assert.equal(value.crossDatabaseSnapshot, 'NON_ATOMIC');
  for (const service of ['orders', 'payments', 'inventory']) {
    const sql = calls.filter(call => call.service === service).map(call => call.sql);
    assert.equal(sql[1], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.ok(sql.indexOf(IDENTITY_SQL) < sql.findIndex(query => query.startsWith('SELECT to_jsonb')));
    assert.deepEqual(sql.slice(-2), ['ROLLBACK', 'END']);
    assert.ok(sql.every(query => /^(CONNECT|END|BEGIN TRANSACTION|SET LOCAL|SELECT|ROLLBACK)/.test(query)));
    // Privilege inspection contains the string literal '...TRUNCATE...'; reject
    // executable mutation syntax, not names inside catalog-query string literals.
    assert.ok(sql.every(query => !/FOR UPDATE|INSERT INTO|UPDATE public|DELETE FROM|TRUNCATE|nextval|COMMIT/i.test(query.replace(/'(?:[^']|'')*'/g, ''))));
  }
});
test('mismatched/unsafe database identities are rejected before any business query and always closed', async () => {
  for (const change of [row => { row.database = 'orders_db'; }, row => { row.role = 'other'; },
    row => { row.database_oid = '999'; }, row => { row.server_port = 999; }, row => { row.read_only = 'off'; },
    row => { row.isolation = 'read committed'; }, row => { row.privileged = true; },
    row => { row.database_owner = true; }, row => { row.owns_relations = true; }]) {
    const calls = [];
    await assert.rejects(inspect(profile(), 77, { clientFactory: fakeFactory(fixture(), calls, change) }), /DATABASE_IDENTITY_OR_ROLE_MISMATCH/);
    assert.ok(!calls.some(call => call.sql.startsWith('SELECT to_jsonb')));
    assert.deepEqual(calls.slice(-2).map(call => call.sql), ['ROLLBACK', 'END']);
  }
});
test('local profiles require SELECT-only roles; write grants are allowed only for pinned isolated application roles', async () => {
  const value = profile(); value.kind = 'local'; value.environment = 'local';
  const calls = [];
  await assert.rejects(inspect(value, 77, { clientFactory: fakeFactory(fixture(), calls, row => { row.mutating_privileges = true; }) }), /DATABASE_IDENTITY_OR_ROLE_MISMATCH/);
  const isolated = await inspect(profile(), 77, { clientFactory: fakeFactory(fixture(), [], row => { row.mutating_privileges = true; }) });
  assert.equal(isolated.sources.orders.identity.roleScope, 'ISOLATED_APPLICATION_ROLE_READ_ONLY_SESSION');
});
test('query failure rolls back and closes the connection; CLI emits no raw error or credentials', async () => {
  const calls = []; const base = fakeFactory(fixture(), calls);
  const clientFactory = (spec, service) => {
    const client = base(spec, service); const query = client.query;
    client.query = async (sql, values) => { if (sql.startsWith('SELECT to_jsonb')) throw new Error('password=must-not-print'); return query(sql, values); };
    return client;
  };
  const output = [];
  const code = await main(['inspect', '--environment', 'isolated-test', '--order-id', '77'], {
    loadProfile: profile, inspect: (p, id) => inspect(p, id, { clientFactory }), output: value => output.push(value),
  });
  assert.equal(code, 1); assert.equal(output[0].error, 'INSPECTION_FAILED');
  assert.ok(!JSON.stringify(output).includes('must-not-print'));
  assert.deepEqual(calls.slice(-2).map(call => call.sql), ['ROLLBACK', 'END']);
});
test('CLI returns a nonzero blocked-plan status and emits review artifacts only', async () => {
  const output = [];
  assert.equal(await main(['plan', '--environment', 'isolated-test', '--order-id', '77', '--action', 'replay-existing'],
    { loadProfile: profile, inspect: async () => fixture(), output: value => output.push(value) }), 0);
  assert.equal(output[0].status, 'REVIEW_REQUIRED');
  assert.equal(await main(['plan', '--environment', 'isolated-test', '--order-id', '77', '--action', 'pay-again'],
    { loadProfile: profile, inspect: async () => fixture(), output: value => output.push(value) }), 2);
});

if (process.env.SAGA_RECOVERY_POSTGRES === 'true') {
  const { createRequire } = require('node:module');
  const { Client } = createRequire(path.resolve(__dirname, '../../../orders-service/package.json'))('pg');
  const config = require('../../phase2/test-support/test-config').loadApplicationConfig();
  async function isolatedProfile() {
    assert.equal(config.project, 'ecommerce-phase21-test');
    const result = { environment: 'isolated-test', kind: 'isolated-test', databases: {} };
    for (const service of ['orders', 'payments', 'inventory']) {
      const spec = config.services[service];
      assert.equal(spec.database, `${service}_phase21_test`);
      const client = new Client({ host: spec.host, port: spec.port, database: spec.database,
        user: spec.application.user, password: spec.application.password, connectionTimeoutMillis: 5000 });
      try {
        await client.connect(); await client.query('BEGIN READ ONLY');
        const row = (await client.query('SELECT current_database() AS database,current_user AS role,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid')).rows[0];
        assert.equal(row.database, spec.database); assert.equal(row.role, spec.role);
        result.databases[service] = { host: spec.host, port: spec.port, database: spec.database, user: spec.role,
          password: spec.application.password, expectedDatabaseOid: row.oid, expectedServerPort: 5432 };
      } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
    }
    return result;
  }
  test('PostgreSQL: isolated restricted roles execute actual inspection SQL without fixture mutations', async () => {
    const value = await inspect(await isolatedProfile(), 2147483647);
    for (const service of ['orders', 'payments', 'inventory']) {
      assert.equal(value.sources[service].identity.database, `${service}_phase21_test`);
      assert.equal(value.sources[service].identity.role, `${service}_app`);
      assert.equal(value.sources[service].identity.readOnly, true);
    }
    assert.ok(plan(value, 'replay-existing').blockers.includes('ORDER_PRESENT'));
  });
  test('PostgreSQL: configured OID mismatch rejects the real connection before business reads', async () => {
    const value = await isolatedProfile(); value.databases.orders.expectedDatabaseOid = '1';
    await assert.rejects(inspect(value, 2147483647), /DATABASE_IDENTITY_OR_ROLE_MISMATCH/);
  });
  test('PostgreSQL: read-only session rejects writes even when the application role has write grants', async () => {
    const value = await isolatedProfile(); const spec = value.databases.orders;
    const client = new Client({ host: spec.host, port: spec.port, database: spec.database, user: spec.user, password: spec.password });
    try {
      await client.connect(); await client.query('BEGIN READ ONLY');
      assert.equal((await client.query('SELECT current_database() AS database,current_user AS role')).rows[0].database, 'orders_phase21_test');
      // WHERE FALSE cannot modify rows; PostgreSQL must still reject the write command.
      await assert.rejects(client.query("UPDATE public.orders SET status='cancelled' WHERE FALSE"), error => error.code === '25006');
    } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
  });
  test('PostgreSQL: real CLI resolves dependencies and profile outside repository cwd without leaking credentials', async () => {
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const value = await isolatedProfile();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-recovery-cli-test-'));
    fs.chmodSync(directory, 0o700);
    const filename = path.join(directory, 'profile.json');
    fs.writeFileSync(filename, JSON.stringify({ version: 1, profiles: { 'isolated-test': {
      kind: value.kind, databases: value.databases } } }), { mode: 0o600 });
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../cli.js'),
        'inspect', '--environment', 'isolated-test', '--order-id', '2147483647'],
      { cwd: directory, env: { PATH: process.env.PATH, SAGA_RECOVERY_CONFIG: filename }, timeout: 30000 });
      const artifact = JSON.parse(stdout);
      assert.equal(artifact.crossDatabaseSnapshot, 'NON_ATOMIC'); assert.equal(stderr, '');
      for (const service of ['orders', 'payments', 'inventory']) {
        assert.equal(artifact.sources[service].identity.role, `${service}_app`);
        assert.ok(!stdout.includes(value.databases[service].password));
      }
    } finally { fs.unlinkSync(filename); fs.rmdirSync(directory); }
  });
  test('PostgreSQL: populated reconciliation, global collisions, exact payloads and SELECT-only roles', async t => {
    const {randomInt}=require('node:crypto');
    const {Pool}=createRequire(path.resolve(__dirname,'../../../orders-service/package.json'))('pg');
    const orderId=randomInt(1000000000,1900000000), eventId=`${orderId}:refund_requested:3`;
    const admins={},readers={},roles={},created=[],seeded=new Set(),outboxIds={orders:[],payments:[],inventory:[]};
    async function seed(service,table,sql,args){
      const result=await admins[service].query(sql+(table==='outbox_events'?' RETURNING id':''),args);
      seeded.add(`${service}/${table}`);
      if(table==='outbox_events')outboxIds[service].push(result.rows[0].id);
      return result;
    }
    const tables={orders:['orders','order_sagas','saga_transitions','outbox_events','inbox_events'],payments:['payments','refunds','outbox_events','inbox_events'],inventory:['reservations','inventory','inventory_order_operations','outbox_events','inbox_events']};
    let originalFailure;
    const saved={NODE_ENV:process.env.NODE_ENV,DB_NAME_TEST:process.env.DB_NAME_TEST,TEST_SERVICE:process.env.TEST_SERVICE};
    try {
      const pinned=await isolatedProfile();
      for(const service of ['orders','payments','inventory']){
        process.env.NODE_ENV='test';process.env.TEST_SERVICE=service;process.env.DB_NAME_TEST=config.services[service].database;
        admins[service]=require('../../phase2/test-support/admin-db')(service,{Pool});
        const role=`saga_ro_${service}_${orderId}`;roles[service]=role;
        // NOLOGIN roles avoid generating or transporting additional credentials.
        await admins[service].query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);created.push(service);
        await admins[service].query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
        await admins[service].query(`GRANT SELECT ON ${tables[service].map(name=>`public.${name}`).join(',')} TO "${role}"`);
        readers[service]={...pinned.databases[service],user:role,password:'unused-no-login-test-role'};
      }
      const payload={orderId,eventId,operationId:`${orderId}:refund_requested`,userId:900001,amount:'20.00',items:[{productId:orderId,quantity:2}],requestId:'isolated-regression',attempt:3};
      await seed('orders','orders',"INSERT INTO orders(id,user_id,items,total_amount,status) VALUES($1,900001,$2,20,'refund_pending')",[orderId,JSON.stringify(payload.items)]);
      await seed('orders','order_sagas',"INSERT INTO order_sagas(order_id,state,version,command_generation,cancel_requested,payment_succeeded,inventory_inactive) VALUES($1,'REFUND_PENDING',7,3,TRUE,TRUE,TRUE)",[orderId]);
      await seed('orders','saga_transitions',"INSERT INTO saga_transitions(order_id,event_id,from_state,to_state) VALUES($1,$2,'PAYMENT_AUTHORIZED','REFUND_PENDING')",[orderId,`expire:${orderId}`]);
      await seed('orders','outbox_events',"INSERT INTO outbox_events(event_type,payload,published,published_at) VALUES('refund_requested',$1,TRUE,NOW())",[JSON.stringify(payload)]);
      await seed('payments','payments',"INSERT INTO payments(order_id,user_id,amount,status) VALUES($1,900001,20,'succeeded')",[orderId]);
      await seed('inventory','inventory','INSERT INTO inventory(product_id,quantity) VALUES($1,10)',[orderId]);
      await seed('inventory','reservations',"INSERT INTO reservations(order_id,product_id,quantity,status,expires_at) VALUES($1,$1,2,'EXPIRED',NOW())",[orderId]);
      const readerProfile={environment:'isolated-reader-test',kind:'local',databases:readers};
      const readerFactory=(spec,service)=>{
        const admin=require('../../phase2/test-support/test-config').loadTestConfig().services[service];
        const client=defaultClient({...spec,user:admin.admin.user,password:admin.admin.password});
        const connect=client.connect.bind(client);
        client.connect=async()=>{await connect();const identity=(await client.query('SELECT current_database() AS database,current_user AS role')).rows[0];assert.equal(identity.database,admin.database);assert.equal(identity.role,admin.admin.user);await client.query(`SET ROLE "${roles[service]}"`);};
        return client;
      };
      const read=()=>inspect(readerProfile,orderId,{clientFactory:readerFactory});
      await t.test('populated SELECT-only inspection produces a review artifact with authoritative text',async()=>{
        const snapshot=await read();const result=plan(snapshot,'replay-existing');assert.equal(result.status,'REVIEW_REQUIRED');
        assert.deepEqual(JSON.parse(result.command.payloadText),payload);
        for(const service of ['orders','payments','inventory'])assert.equal(snapshot.sources[service].identity.roleScope,'READ_ONLY_ROLE');
        for(const service of ['orders','payments','inventory']){
          const client=readerFactory(readers[service],service);try{await client.connect();await assert.rejects(client.query(`UPDATE public.outbox_events SET published=TRUE WHERE FALSE`),error=>error.code==='42501');}finally{await client.end();}
        }
      });
      await t.test('global cross-order inbox collision is visible and blocked',async()=>{
        await seed('payments','inbox_events',"INSERT INTO inbox_events(event_id,event_type,order_id) VALUES($1,'refund_requested',$2)",[eventId,orderId+1]);
        try{assert.ok(plan(await read(),'replay-existing').blockers.includes('GLOBAL_INBOX_ID_CONFLICT'));}
        finally{await admins.payments.query('DELETE FROM inbox_events WHERE event_id=$1',[eventId]);}
      });
      await t.test('global cross-order result collision is visible and blocked',async()=>{
        const conflict={...payload,orderId:orderId+1,eventId:`${eventId}:result`,status:'refunded'};
        const inserted=await seed('payments','outbox_events',"INSERT INTO outbox_events(event_type,payload) VALUES('refund_processed',$1)",[JSON.stringify(conflict)]);
        try{assert.ok(plan(await read(),'replay-existing').blockers.includes('GLOBAL_OUTBOX_ID_CONFLICT'));}
        finally{await admins.payments.query('DELETE FROM outbox_events WHERE id=$1',[inserted.rows[0].id]);}
      });
      await t.test('distinct high-precision persisted JSONB values are rejected without rounding',async()=>{
        for(const amount of ['20.0000000000000001','20.0000000000000002']){
          await admins.orders.query("UPDATE outbox_events SET payload=jsonb_set(payload,'{amount}',$1::jsonb) WHERE payload->>'eventId'=$2",[amount,eventId]);
          const snapshot=await read();const result=plan(snapshot,'replay-existing');assert.equal(result.status,'BLOCKED');assert.equal(result.commandFingerprint,undefined);
          assert.ok(snapshot.sources.orders.records.outbox[0].payloadText.includes(amount));
        }
        await admins.orders.query("UPDATE outbox_events SET payload=$1::jsonb WHERE payload->>'eventId'=$2",[JSON.stringify(payload),eventId]);
      });
      await t.test('global-only expected result payload conflicts are rejected by actual inspection',async()=>{
        for(const change of [{orderId:orderId+1},{operationId:'other-operation'},{amount:'21.00'}]){
          const conflict={...payload,eventId:`${eventId}:result`,status:'refunded',...change};
          const inserted=await seed('payments','outbox_events',"INSERT INTO outbox_events(event_type,payload) VALUES('refund_processed',$1)",[JSON.stringify(conflict)]);
          try { assert.equal(verify(await read()).status,'CONFLICT'); }
          finally { await admins.payments.query('DELETE FROM outbox_events WHERE id=$1',[inserted.rows[0].id]); }
        }
      });
      await t.test('persisted successful refund and correlated transition support release planning',async()=>{
        const result={orderId,eventId:`${eventId}:result`,operationId:payload.operationId,userId:900001,amount:'20.00',status:'refunded',requestId:payload.requestId};
        await seed('payments','refunds',"INSERT INTO refunds(order_id,user_id,amount,status) VALUES($1,900001,20,'refunded')",[orderId]);
        await seed('payments','outbox_events',"INSERT INTO outbox_events(event_type,payload,published,published_at) VALUES('refund_processed',$1,TRUE,NOW())",[JSON.stringify(result)]);
        await seed('orders','inbox_events',"INSERT INTO inbox_events(event_id,event_type,order_id,processed_at) VALUES($1,'refund_processed',$2,NOW())",[result.eventId,orderId]);
        await seed('orders','saga_transitions',"INSERT INTO saga_transitions(order_id,event_id,from_state,to_state) VALUES($1,$2,'REFUND_PENDING','RELEASE_PENDING')",[orderId,result.eventId]);
        await admins.orders.query("UPDATE order_sagas SET state='RELEASE_PENDING',refund_succeeded=TRUE,command_generation=4 WHERE order_id=$1",[orderId]);
        const release={...payload,eventId:`${orderId}:inventory_release_requested:4`,operationId:`${orderId}:inventory_release_requested`,attempt:4};
        await seed('orders','outbox_events',"INSERT INTO outbox_events(event_type,payload,published,published_at) VALUES('inventory_release_requested',$1,TRUE,NOW())",[JSON.stringify(release)]);
        assert.equal(plan(await read(),'replay-existing').status,'REVIEW_REQUIRED');
        const released={orderId,eventId:require('node:crypto').randomUUID(),allInactive:true};
        await seed('inventory','outbox_events',"INSERT INTO outbox_events(event_type,payload,published,published_at) VALUES('inventory_released',$1,TRUE,NOW())",[JSON.stringify(released)]);
        await seed('orders','inbox_events',"INSERT INTO inbox_events(event_id,event_type,order_id,processed_at) VALUES($1,'inventory_released',$2,NOW())",[released.eventId,orderId]);
        await seed('orders','saga_transitions',"INSERT INTO saga_transitions(order_id,event_id,from_state,to_state) VALUES($1,$2,'RELEASE_PENDING','CANCELLED')",[orderId,released.eventId]);
        await admins.orders.query("UPDATE order_sagas SET state='CANCELLED' WHERE order_id=$1",[orderId]);
        await admins.orders.query("UPDATE orders SET status='cancelled' WHERE id=$1",[orderId]);
        assert.equal(verify(await read()).status,'CONSISTENT_WITH_LIMITATIONS');
        for(const [service, event] of [['inventory',released],['payments',result]]){
          const conflict={...event,orderId:orderId+1};
          const inserted=await seed(service,'outbox_events',"INSERT INTO outbox_events(event_type,payload) VALUES($1,$2)",[service==='inventory'?'inventory_released':'refund_processed',JSON.stringify(conflict)]);
          try { assert.equal(verify(await read()).status,'CONFLICT'); }
          finally { await admins[service].query('DELETE FROM outbox_events WHERE id=$1',[inserted.rows[0].id]); }
        }
        await admins.orders.query("DELETE FROM saga_transitions WHERE order_id=$1 AND event_id=$2",[orderId,result.eventId]);
        assert.equal(verify(await read()).status,'CONFLICT');
      });
    } catch (error) { originalFailure = error; throw error;
    } finally {
      const failures=[];
      const attempt=action=>cleanupAttempt(failures,action);
      try {
        for(const service of Object.keys(admins)){
          const admin=admins[service];
          try {
            const financial=service==='payments'?['payments','refunds']:service==='inventory'?['reservations','inventory_order_operations']:['saga_transitions','order_sagas'];
            for(const table of financial)if(seeded.has(`${service}/${table}`))await attempt(()=>admin.query(`DELETE FROM public.${table} WHERE order_id=$1`,[orderId]));
            await attempt(async()=>{await admin.query('DELETE FROM public.outbox_events WHERE id=ANY($1::int[])',[outboxIds[service]]);});
            if(seeded.has(`${service}/inbox_events`))await attempt(()=>admin.query('DELETE FROM public.inbox_events WHERE order_id=$1 OR event_id=$2',[orderId,eventId]));
            if(service==='orders'&&seeded.has('orders/orders'))await attempt(()=>admin.query('DELETE FROM public.orders WHERE id=$1',[orderId]));
            if(service==='inventory'&&seeded.has('inventory/inventory')){
              await attempt(()=>admin.query('DELETE FROM public.inventory WHERE product_id=$1',[orderId]));
              await attempt(async()=>assert.equal((await admin.query('SELECT count(*)::int AS count FROM public.inventory WHERE product_id=$1',[orderId])).rows[0].count,0));
            }
            if(created.includes(service)){
            await attempt(async()=>{await admin.query(`REVOKE SELECT ON ${tables[service].map(name=>`public.${name}`).join(',')} FROM "${roles[service]}"`);});
            await attempt(async()=>{await admin.query(`REVOKE USAGE ON SCHEMA public FROM "${roles[service]}"`);});
            await attempt(async()=>{await admin.query(`DROP ROLE "${roles[service]}"`);});
            }
          } finally { await attempt(()=>admin.end()); }
        }
      } finally {
        for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      }
      if(failures.length){
        if(originalFailure)t.diagnostic(`Cleanup encountered ${failures.length} additional failure(s); original test failure preserved.`);
        else throw new AggregateError(failures,'Isolated fixture cleanup failed');
      }
    }
  });

} else {
  test('PostgreSQL integration requires SAGA_RECOVERY_POSTGRES=true and existing isolated configuration', { skip: true }, () => {});
}
