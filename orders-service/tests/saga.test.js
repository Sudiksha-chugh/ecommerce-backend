const { decide } = require('../src/saga');
const initial = () => ({state:'PENDING',payment_succeeded:false,refund_succeeded:false,inventory_inactive:false});
const apply = (s,t,e) => decide(s,t,e).saga;
test('success path and duplicate results',()=>{
 let s=apply(initial(),'inventory_reserved');
 s=apply(s,'payment_processed',{status:'succeeded'});
 expect(s.state).toBe('PAYMENT_AUTHORIZED');
 s=apply(s,'inventory_confirmed'); expect(s.state).toBe('CONFIRMED');
 expect(decide(s,'payment_processed',{status:'succeeded'}).commands).toEqual([]);
});
test('insufficient stock cancels without payment',()=>{
 const r=decide(initial(),'inventory_reservation_failed'); expect(r.saga.state).toBe('CANCELLED'); expect(r.saga.failure_state).toBe('STOCK_FAILED'); expect(r.commands).toEqual([]);
});
test('payment failure waits for release',()=>{
 let s=apply(initial(),'inventory_reserved');s=apply(s,'payment_processed',{status:'failed'});expect(s.state).toBe('RELEASE_PENDING');expect(s.failure_state).toBe('PAYMENT_FAILED');s=apply(s,'inventory_released');expect(s.state).toBe('CANCELLED');
});
test('paid expired reservation waits for refund then inventory verification',()=>{
 let s={...initial(),state:'PAYMENT_AUTHORIZED',payment_succeeded:true};
 s=apply(s,'inventory_expired');expect(s.state).toBe('REFUND_PENDING');
 s=apply(s,'refund_processed',{status:'refunded'});expect(s.state).toBe('RELEASE_PENDING');
 s=apply(s,'inventory_released');expect(s.state).toBe('CANCELLED');
});
test('refund failure stays incomplete and can retry',()=>{
 let s={...initial(),state:'REFUND_PENDING',payment_succeeded:true};s=apply(s,'refund_processed',{status:'failed'});expect(s.state).toBe('REFUND_FAILED');s=apply(s,'cancel_requested');expect(s.state).toBe('REFUND_PENDING');expect(s.refund_succeeded).toBe(false);
});
test('cancellation before reservation waits for reserve result and release',()=>{
 let s=apply(initial(),'cancel_requested');expect(s.state).toBe('CANCEL_REQUESTED');const r=decide(s,'inventory_reserved');expect(r.commands).toEqual(['inventory_release_requested']);expect(apply(r.saga,'inventory_released').state).toBe('CANCELLED');
});
test('cancellation with payment in flight waits for outcome',()=>{
 let s=apply(initial(),'inventory_reserved');s=apply(s,'cancel_requested');expect(s.state).toBe('STOCK_RESERVED');expect(decide(s,'payment_processed',{status:'succeeded'}).commands).toEqual(['refund_requested']);
});
test('out of order refund or confirmation cannot complete pending order',()=>{
 expect(apply(initial(),'refund_processed',{status:'refunded'}).state).toBe('PENDING');expect(apply(initial(),'inventory_confirmed').state).toBe('PENDING');
});
