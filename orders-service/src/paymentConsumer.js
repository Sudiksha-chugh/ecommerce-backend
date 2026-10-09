// All result queues share the durable Saga transport.
const { start } = require('./sagaConsumer');
module.exports = { startPaymentConsumer: start };
