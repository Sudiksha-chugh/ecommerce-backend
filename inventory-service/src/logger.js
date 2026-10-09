const winston = require('winston');
const { ElasticsearchTransport } = require('winston-elasticsearch');
require('dotenv').config();

const esTransportOpts = {
  level: 'info',
  clientOpts: { node: process.env.ES_NODE || 'http://localhost:9200' },
  index: process.env.LOG_INDEX || 'ecommerce-logs-write',
  ensureIndexTemplate: false,
  transformer: (logData) => ({
    '@timestamp': new Date().toISOString(),
    service: 'inventory-service',
    level: logData.level,
    message: logData.message,
    meta: require('./logIdentifiers').normalizeIdentifiers(logData.meta || {}),
  }),
};

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  }),
];

if (process.env.NODE_ENV !== 'test') {
  transports.push(new ElasticsearchTransport(esTransportOpts));
}

const logger = winston.createLogger({
  silent: process.env.NODE_ENV === "test",
  level: 'info',
  format: winston.format.combine(winston.format(info => Object.assign(info, require('./logIdentifiers').normalizeIdentifiers(info)))(), winston.format.json()),
  defaultMeta: { service: 'inventory-service' },
  transports,
  exitOnError: false,
});

logger.on('error', (err) => {
  console.error('Logger transport error (non-fatal):', err.message || err);
});

module.exports = logger;
