const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve(__dirname, '../../.env'),
});

process.env.NODE_ENV = 'test';

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5437';
process.env.DB_USER = process.env.DB_USER || 'inventory_user';
process.env.DB_PASSWORD =
  process.env.DB_PASSWORD || process.env.INVENTORY_DB_PASSWORD;
process.env.DB_NAME = process.env.DB_NAME || 'inventory_db';
process.env.DB_NAME_TEST =
  process.env.DB_NAME_TEST || 'inventory_db';

process.env.INTERNAL_SERVICE_KEY =
  process.env.INTERNAL_SERVICE_KEY || 'test-internal-service-key';

process.env.RABBITMQ_URL =
  process.env.RABBITMQ_URL ||
  process.env.INVENTORY_RABBITMQ_URL;