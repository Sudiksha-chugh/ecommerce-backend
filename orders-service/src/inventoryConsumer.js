const { processSagaEvent } = require('./sagaStore');
const transport = require('./sagaConsumer');
module.exports = {
 startInventoryConsumer: transport.start,
 processInventoryReserved: event => processSagaEvent('inventory_reserved', event),
 processInventoryReservationFailed: event => processSagaEvent('inventory_reservation_failed', event),
 processInventoryConfirmed: event => processSagaEvent('inventory_confirmed', event),
 processInventoryReleased: event => processSagaEvent('inventory_released', event),
};
