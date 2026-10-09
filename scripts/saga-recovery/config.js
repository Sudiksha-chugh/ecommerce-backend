'use strict';

const fs = require('node:fs');
const net = require('node:net');
const SERVICES = ['orders', 'payments', 'inventory'];
const identifier = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactKeys(object, keys, code) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
      Object.keys(object).some(key => !keys.includes(key))) throw fail(code);
}

function validateProfile(environment, profile) {
  if (typeof environment !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(environment)) throw fail('INVALID_ENVIRONMENT');
  exactKeys(profile, ['kind', 'databases'], 'INVALID_PROFILE');
  // Remote/production profiles require a separately reviewed TLS/authorization design.
  if (!['local', 'isolated-test'].includes(profile.kind)) throw fail('UNSUPPORTED_ENVIRONMENT_KIND');
  exactKeys(profile.databases, SERVICES, 'INVALID_DATABASE_CONFIGURATION');
  const targets = new Set();
  const databases = new Set();
  for (const service of SERVICES) {
    const spec = profile.databases[service];
    exactKeys(spec, ['host', 'port', 'database', 'user', 'password', 'expectedDatabaseOid', 'expectedServerPort'], 'INVALID_DATABASE_CONFIGURATION');
    if (!['127.0.0.1', '::1'].includes(spec.host) || !net.isIP(spec.host) ||
        !Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535 ||
        !Number.isInteger(spec.expectedServerPort) || spec.expectedServerPort < 1 || spec.expectedServerPort > 65535 ||
        !identifier.test(spec.database || '') || !identifier.test(spec.user || '') ||
        ['postgres', 'phase21_admin'].includes(spec.user) ||
        typeof spec.password !== 'string' || !spec.password ||
        typeof spec.expectedDatabaseOid !== 'string' || !/^[1-9][0-9]{0,9}$/.test(spec.expectedDatabaseOid) ||
        BigInt(spec.expectedDatabaseOid) > 4294967295n) throw fail('UNSAFE_DATABASE_CONFIGURATION');
    if (profile.kind === 'isolated-test' && (spec.database !== `${service}_phase21_test` ||
        spec.host !== '127.0.0.1' || spec.port !== { orders: 55435, payments: 55436, inventory: 55437 }[service] ||
        spec.user !== `${service}_app`)) throw fail('UNSAFE_TEST_TARGET');
    const target = `${spec.host}:${spec.port}/${spec.database}`;
    if (targets.has(target) || databases.has(spec.database)) throw fail('AMBIGUOUS_DATABASE_TARGETS');
    targets.add(target);
    databases.add(spec.database);
  }
  return { environment, kind: profile.kind, databases: structuredClone(profile.databases) };
}

function loadProfile(environment, filename = process.env.SAGA_RECOVERY_CONFIG) {
  if (!environment) throw fail('ENVIRONMENT_REQUIRED');
  if (!filename || typeof filename !== 'string' || !require('node:path').isAbsolute(filename)) throw fail('EXPLICIT_CONFIG_PATH_REQUIRED');
  let document;
  let descriptor;
  try {
    const stat = fs.lstatSync(filename);
    const parent = fs.lstatSync(require('node:path').dirname(filename));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) ||
        !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o022) ||
        stat.size > 65536) throw fail('UNSAFE_CONFIG_FILE');
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== process.getuid() || (opened.mode & 0o077) || opened.size > 65536) throw fail('UNSAFE_CONFIG_FILE');
    document = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error.code === 'UNSAFE_CONFIG_FILE') throw error;
    throw fail('CONFIG_UNAVAILABLE_OR_INVALID');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  exactKeys(document, ['version', 'profiles'], 'INVALID_CONFIG');
  if (document.version !== 1 || !document.profiles || typeof document.profiles !== 'object' || Array.isArray(document.profiles) ||
      !Object.hasOwn(document.profiles, environment)) throw fail('UNKNOWN_ENVIRONMENT');
  return validateProfile(environment, document.profiles[environment]);
}

function validateOrderId(value) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw fail('INVALID_ORDER_ID');
  return Number(value);
}

module.exports = { SERVICES, fail, loadProfile, validateProfile, validateOrderId };
