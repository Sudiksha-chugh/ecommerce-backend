const {EventEmitter}=require('events');
const {publishConfirmed}=require('../src/publishConfirmed');
test('unroutable mandatory publication remains retryable despite broker confirm',async()=>{
 const ch=new EventEmitter();ch.publish=jest.fn((x,key,body,options)=>ch.emit('return',{properties:{messageId:options.messageId}}));ch.waitForConfirms=jest.fn().mockResolvedValue();await expect(publishConfirmed(ch,'missing_queue',{eventId:'stable-id',orderId:1})).rejects.toMatchObject({code:'UNROUTABLE_EVENT'});expect(ch.listenerCount('return')).toBe(0);
});
test('routed publication preserves event identity',async()=>{
 const ch=new EventEmitter();ch.publish=jest.fn();ch.waitForConfirms=jest.fn().mockResolvedValue();await publishConfirmed(ch,'payment_requested',{eventId:'stable-id',orderId:1});expect(ch.publish.mock.calls[0][3]).toMatchObject({messageId:'stable-id',mandatory:true,persistent:true});
});
