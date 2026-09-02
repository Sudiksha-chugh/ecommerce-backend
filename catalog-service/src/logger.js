const winston = require('winston');
const { ElasticsearchTransport } = require('winston-elasticsearch');
require('dotenv').config();

const esTransportOpts = {
  level: 'info',
  clientOpts: { node: process.env.ES_NODE || 'http://localhost:9200' },
  index: 'logs',
  transformer: (logData) => ({
    '@timestamp': new Date().toISOString(),
    service: 'catalog-service',
    level: logData.level,
    message: logData.message,
    meta: logData.meta,
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
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'catalog-service' },
  transports,
  exitOnError: false,
});

module.exports = logger;