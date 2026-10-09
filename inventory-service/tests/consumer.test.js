jest.mock('amqplib');
jest.mock('../src/inventoryService',()=>({reserveInventory:jest.fn(),confirmInventory:jest.fn(),releaseInventory:jest.fn()}));
require('../../scripts/phase2/test-support/consumer-contract')(()=>{
 const consumer=require('../src/consumer');return {amqp:require('amqplib'),operation:require('../src/inventoryService').reserveInventory,transport:{start:consumer.connectInventoryConsumer,stop:consumer.stopInventoryConsumer}};
},['inventory_reserve_requested','inventory_confirm_requested','inventory_release_requested']);
