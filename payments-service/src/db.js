const { Pool } = require('pg');
require('dotenv').config();


if (process.env.NODE_ENV === 'test' && (!process.env.DB_NAME_TEST || !process.env.DB_NAME_TEST.endsWith('_test') || process.env.DB_NAME_TEST === process.env.DB_NAME)) {
  throw new Error('Tests require an isolated DB_NAME_TEST ending in _test, different from DB_NAME');
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.NODE_ENV === 'test' ? process.env.DB_NAME_TEST : process.env.DB_NAME,
});

module.exports = pool;