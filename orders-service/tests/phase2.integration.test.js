// Cross-service integration is opt-in and uses the isolated local harness.
if (process.env.PHASE2_INTEGRATION === 'true') {
const config=require('../../inventory-service/node_modules/dotenv').config({path:require("path").resolve(__dirname,"../../.env"),quiet:true}).parsed;
const ordersPool=require('../src/db');
const {processSagaEvent}=require('../src/sagaStore');
const saved={...process.env};
Object.assign(process.env,{DB_PORT:'5437',DB_USER:'inventory_user',DB_PASSWORD:config.INVENTORY_DB_PASSWORD,DB_NAME:'inventory_db',DB_NAME_TEST:'inventory_phase2_test'});
const inventoryPool=require('../../inventory-service/src/db');
const inventory=require('../../inventory-service/src/inventoryService');
const {releaseExpiredReservations}=require('../../inventory-service/src/inventoryExpiration');
Object.assign(process.env,{DB_PORT:'5436',DB_USER:'payments_app',DB_PASSWORD:config.PAYMENTS_APP_DB_PASSWORD,DB_NAME:'payments_db',DB_NAME_TEST:'payments_phase2_test'});
const paymentsPool=require('../../payments-service/src/db');
const {processRequest}=require('../../payments-service/src/paymentStore');
Object.assign(process.env,saved);
const fixturePools=['orders','inventory','payments'].map(name=>require('../../scripts/phase2/test-support/admin-db')(name,require('pg')));
let orderId;
async function state(){return (await ordersPool.query('SELECT * FROM order_sagas WHERE order_id=$1',[orderId])).rows[0];}
async function stock(){return (await inventoryPool.query('SELECT quantity FROM inventory WHERE product_id=1')).rows[0].quantity;}
async function drain(){
 for(let i=0;i<12;i++){
  let processed=0;
  for(const [pool,owner] of [[ordersPool,'orders'],[inventoryPool,'inventory'],[paymentsPool,'payments']]){
   const events=(await pool.query('SELECT * FROM outbox_events WHERE NOT published ORDER BY id')).rows;
   for(const e of events){
    await pool.query('UPDATE outbox_events SET published=TRUE WHERE id=$1',[e.id]);processed++;
    if(owner==='orders') {
     if(e.event_type==='inventory_reserve_requested') await inventory.reserveInventory(e.payload);
     else if(e.event_type==='inventory_confirm_requested') await inventory.confirmInventory(e.payload);
     else if(e.event_type==='inventory_release_requested') await inventory.releaseInventory(e.payload);
     else await processRequest(e.event_type,e.payload);
    }else await processSagaEvent(e.event_type,e.payload);
   }
  }
  if(!processed)return;
 }
 throw new Error('Event drain did not converge');
}
beforeEach(async()=>{
 for(const pool of [ordersPool,inventoryPool,paymentsPool]){
  const db=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  if(!db.endsWith('_phase2_test'))throw new Error('Unsafe database');
 }
 await fixturePools[0].query('TRUNCATE orders,order_sagas,inbox_events,outbox_events RESTART IDENTITY CASCADE');
 await fixturePools[1].query('TRUNCATE inventory,reservations,inbox_events,inventory_order_operations,outbox_events RESTART IDENTITY');
 await fixturePools[2].query('TRUNCATE payments,refunds,inbox_events,outbox_events RESTART IDENTITY');
 await inventoryPool.query('INSERT INTO inventory(product_id,quantity) VALUES(1,10)');
 const order=(await ordersPool.query(`INSERT INTO orders(user_id,items,total_amount) VALUES(22,'[{"productId":1,"quantity":2}]',20) RETURNING id,items`)).rows[0];orderId=order.id;
 await ordersPool.query("INSERT INTO order_sagas(order_id,state) VALUES($1,'PENDING')",[orderId]);
 await ordersPool.query('INSERT INTO outbox_events(event_type,payload) VALUES($1,$2)',['inventory_reserve_requested',JSON.stringify({eventId:`${orderId}:reserve`,orderId,userId:22,amount:20,items:order.items})]);
 delete process.env.PAYMENT_OUTCOME;delete process.env.REFUND_OUTCOME;
});
afterAll(async()=>{await Promise.all([ordersPool.end(),inventoryPool.end(),paymentsPool.end(),...fixturePools.map(p=>p.end())]);});
test('success then cancellation refunds and restores exactly once',async()=>{
 await drain();expect((await state()).state).toBe('CONFIRMED');expect(await stock()).toBe(8);
 await processSagaEvent('cancel_requested',{eventId:'cancel',orderId});await drain();expect((await state()).state).toBe('CANCELLED');expect(await stock()).toBe(10);
 await processSagaEvent('cancel_requested',{eventId:'cancel-again',orderId});await drain();expect(await stock()).toBe(10);expect((await paymentsPool.query('SELECT * FROM refunds')).rows).toHaveLength(1);
});
test('insufficient stock never initiates payment',async()=>{
 await inventoryPool.query('UPDATE inventory SET quantity=1');await drain();expect((await state()).state).toBe('CANCELLED');expect((await paymentsPool.query('SELECT * FROM payments')).rows).toHaveLength(0);expect(await stock()).toBe(1);
});
test('payment failure restores inventory',async()=>{
 process.env.PAYMENT_OUTCOME='failed';await drain();expect((await state()).state).toBe('CANCELLED');expect(await stock()).toBe(10);
});
test('cancellation before reserve handles in-flight reservation',async()=>{
 await processSagaEvent('cancel_requested',{eventId:'cancel',orderId});await drain();expect((await state()).state).toBe('CANCELLED');expect(await stock()).toBe(10);expect((await paymentsPool.query('SELECT * FROM payments')).rows).toHaveLength(0);
});
test('successful payment after expiration compensates without new reservation',async()=>{
 const reserve=(await ordersPool.query('SELECT payload FROM outbox_events')).rows[0].payload;
 await inventory.reserveInventory(reserve);await inventoryPool.query("UPDATE reservations SET expires_at=NOW()-INTERVAL '1 minute'");await releaseExpiredReservations();
 await ordersPool.query('UPDATE outbox_events SET published=TRUE');await drain();
 expect((await state()).state).toBe('CANCELLED');expect(await stock()).toBe(10);expect((await inventoryPool.query('SELECT status FROM reservations')).rows[0].status).toBe('EXPIRED');expect((await paymentsPool.query('SELECT * FROM refunds')).rows).toHaveLength(1);
});
test('refund failure is durable and explicit retry succeeds once',async()=>{
 await drain();process.env.REFUND_OUTCOME='failed';await processSagaEvent('cancel_requested',{eventId:'cancel',orderId});await drain();expect((await state()).state).toBe('REFUND_FAILED');expect(await stock()).toBe(8);
 delete process.env.REFUND_OUTCOME;await processSagaEvent('cancel_requested',{eventId:'retry',orderId});await drain();expect((await state()).state).toBe('CANCELLED');expect(await stock()).toBe(10);expect((await paymentsPool.query('SELECT * FROM refunds')).rows).toHaveLength(1);
});
test('redelivered reserve, payment and results retain durable deduplication',async()=>{
 await drain();
 const reserve=(await ordersPool.query("SELECT payload FROM outbox_events WHERE event_type='inventory_reserve_requested'")).rows[0].payload;
 await inventory.reserveInventory(reserve);
 const payment=(await ordersPool.query("SELECT payload FROM outbox_events WHERE event_type='payment_requested'")).rows[0].payload;
 await processRequest('payment_requested',payment);
 const result=(await paymentsPool.query('SELECT payload FROM outbox_events')).rows[0].payload;
 await processSagaEvent('payment_processed',result);await drain();expect(await stock()).toBe(8);expect((await paymentsPool.query('SELECT * FROM payments')).rows).toHaveLength(1);expect((await state()).state).toBe('CONFIRMED');
});
test('confirmation and expiration race has a consistent outcome',async()=>{
 const reserve=(await ordersPool.query('SELECT payload FROM outbox_events')).rows[0].payload;await inventory.reserveInventory(reserve);
 await inventoryPool.query("UPDATE reservations SET expires_at=NOW()-INTERVAL '1 minute'");
 const [confirmation]=await Promise.all([inventory.confirmInventory({orderId,eventId:'confirm-race'}),releaseExpiredReservations()]);
 expect(confirmation.confirmed).toBe(false);expect(await stock()).toBe(10);expect((await inventoryPool.query('SELECT status FROM reservations')).rows[0].status).toBe('EXPIRED');
});

test('out-of-order financial result rolls back inbox and remains replayable',async()=>{
 const event={eventId:'early-payment',orderId,status:'succeeded'};
 await expect(processSagaEvent('payment_processed',event)).rejects.toMatchObject({code:'OUT_OF_ORDER'});
 expect((await ordersPool.query("SELECT * FROM inbox_events WHERE event_id='early-payment'")).rows).toHaveLength(0);
 await drain();expect((await state()).state).toBe('CONFIRMED');
 await processSagaEvent('payment_processed',event);expect((await state()).state).toBe('CONFIRMED');
});
test('timeout reconciliation is bounded and retains operation identity',async()=>{
 const {pollOnce}=require('../src/sagaTimeout');
 const before=(await ordersPool.query('SELECT payload FROM outbox_events')).rows[0].payload;
 for(let i=0;i<4;i++){
  await ordersPool.query("UPDATE order_sagas SET updated_at=NOW()-INTERVAL '1 hour'");await pollOnce();
 }
 const after=(await ordersPool.query('SELECT payload FROM outbox_events')).rows[0].payload;
 expect(after.eventId).toBe(before.eventId);expect(after.reconcileAttempts).toBe(3);expect((await state()).last_error).toContain('manual reconciliation');
});

} else {test.skip('Cross-service integration requires the isolated Phase 2 harness',()=>{});}
