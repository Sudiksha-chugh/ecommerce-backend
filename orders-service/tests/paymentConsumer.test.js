jest.mock('amqplib');
jest.mock('../src/sagaStore',()=>({processSagaEvent:jest.fn()}));
require('../../scripts/phase2/test-support/consumer-contract')(()=>({
 amqp:require('amqplib'),operation:require('../src/sagaStore').processSagaEvent,transport:require('../src/sagaConsumer')
}),['inventory_reserved','inventory_reservation_failed','inventory_confirmed','inventory_released','inventory_expired','inventory_confirmation_failed','payment_processed','refund_processed']);
