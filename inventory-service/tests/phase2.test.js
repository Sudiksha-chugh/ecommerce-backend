jest.mock('../src/db',()=>({connect:jest.fn()}));
const pool=require('../src/db');
const {confirmInventory,releaseInventory}=require('../src/inventoryService');
function client(rows){return {query:jest.fn(async(sql)=>{if(sql.startsWith('SELECT *, expires_at'))return {rows};if(sql.includes("status IN ('RELEASED', 'EXPIRED')"))return {rows:[{status:'EXPIRED'}]};return {rows:[]};}),release:jest.fn()};}
test('expired reservation never executes confirmation update and emits failure',async()=>{
 const c=client([{status:'EXPIRED'}]);pool.connect.mockResolvedValue(c);const r=await confirmInventory({orderId:56});expect(r.confirmed).toBe(false);expect(c.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE reservations'))).toBe(false);expect(c.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO outbox_events'))[1][0]).toBe('inventory_confirmation_failed');
});
test('overdue pending reservation cannot be confirmed',async()=>{
 const c=client([{status:'PENDING',overdue:true}]);pool.connect.mockResolvedValue(c);expect((await confirmInventory({orderId:56})).confirmed).toBe(false);expect(c.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE reservations'))).toBe(false);
});
test('already expired release verifies inactivity without restoring stock again',async()=>{
 const c=client([]);pool.connect.mockResolvedValue(c);expect((await releaseInventory({orderId:56})).alreadyReleased).toBe(true);expect(c.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE inventory'))).toBe(false);expect(c.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO outbox_events'))[1][0]).toBe('inventory_released');
});
