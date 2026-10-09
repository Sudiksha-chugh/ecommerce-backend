// Shared transport assertions; each service supplies its own mocked operation.
module.exports = function contract(load, queues) {
 let transport,channel,connection,amqp,operation,handlers;
 beforeEach(()=>{
  jest.resetModules();handlers={};
  channel={assertExchange:jest.fn().mockResolvedValue({}),assertQueue:jest.fn().mockResolvedValue({}),bindQueue:jest.fn().mockResolvedValue({}),prefetch:jest.fn().mockResolvedValue({}),on:jest.fn(),cancel:jest.fn().mockResolvedValue({}),ack:jest.fn(),consume:jest.fn(async(q,h)=>{handlers[q]=h;return {consumerTag:q};}),publish:jest.fn((exchange,key,body,options,callback)=>{callback(null);return true;})};
  connection={createConfirmChannel:jest.fn().mockResolvedValue(channel),on:jest.fn(),close:jest.fn().mockResolvedValue()};
  ({transport,amqp,operation}=load());amqp.connect.mockResolvedValue(connection);operation.mockResolvedValue({});
 });
 afterEach(async()=>{await transport.stop();jest.useRealTimers();});
 test('durable queues, DLQs, bindings, and bounded prefetch',async()=>{
  await transport.start();for(const q of queues){expect(handlers[q]).toEqual(expect.any(Function));expect(channel.assertQueue).toHaveBeenCalledWith(q,{durable:true});expect(channel.assertQueue).toHaveBeenCalledWith(`${q}_dlq`,{durable:true});}expect(channel.prefetch).toHaveBeenCalledWith(1);
 });
 test('successful processing acknowledges after operation',async()=>{
  await transport.start();const msg={content:Buffer.from(JSON.stringify({eventId:'e',orderId:1,userId:22,amount:20,items:[{productId:1,quantity:2}],status:'succeeded'}))};await handlers[queues[0]](msg);expect(operation).toHaveBeenCalled();expect(channel.ack).toHaveBeenCalledWith(msg);
 });
 test('poison JSON is acknowledged only after DLQ confirmation',async()=>{
  await transport.start();let confirm;channel.publish.mockImplementation((x,k,b,o,cb)=>{confirm=cb;return true;});const msg={content:Buffer.from('{invalid')};const task=handlers[queues[0]](msg);await Promise.resolve();expect(channel.ack).not.toHaveBeenCalled();confirm(null);await task;expect(channel.ack).toHaveBeenCalledWith(msg);
 });
 test('failed DLQ confirmation leaves message unacknowledged',async()=>{
  await transport.start();channel.publish.mockImplementation((x,k,b,o,cb)=>{cb(new Error('lost connection'));return true;});const msg={content:Buffer.from('{invalid')};await handlers[queues[0]](msg);expect(channel.ack).not.toHaveBeenCalled();expect(connection.close).toHaveBeenCalled();
 });
 test('reconnect registers subscriptions after broker close',async()=>{
  jest.useFakeTimers();await transport.start();const onClose=connection.on.mock.calls.find(c=>c[0]==='close')[1];onClose();await jest.advanceTimersByTimeAsync(3000);expect(amqp.connect).toHaveBeenCalledTimes(2);expect(channel.consume).toHaveBeenCalledTimes(queues.length*2);
 });
 test('technical errors have exactly three attempts then confirmed DLQ',async()=>{
  jest.useFakeTimers();await transport.start();operation.mockRejectedValue(new Error('temporary failure'));const msg={content:Buffer.from(JSON.stringify({eventId:'e',orderId:1,userId:22,amount:20,items:[{productId:1,quantity:2}],status:'succeeded'}))};const task=handlers[queues[0]](msg);await jest.advanceTimersByTimeAsync(1000);await task;expect(operation).toHaveBeenCalledTimes(3);expect(channel.publish).toHaveBeenCalledWith('app.events',`${queues[0]}_dlq`,msg.content,expect.objectContaining({persistent:true}),expect.any(Function));expect(channel.ack).toHaveBeenCalledWith(msg);
 });
};
