jest.mock('amqplib');
jest.mock('../src/paymentStore',()=>({processRequest:jest.fn()}));
require('../../scripts/phase2/test-support/consumer-contract')(()=>{
 const consumer=require('../src/consumer');return {amqp:require('amqplib'),operation:require('../src/paymentStore').processRequest,transport:{start:consumer.startConsumer,stop:consumer.stopConsumer}};
},['payment_requested','refund_requested']);
