#!/usr/bin/env node
'use strict';

const { fail, loadProfile, validateOrderId } = require('./config');
const { inspect, publicInspection } = require('./inspect');
const { plan } = require('./plan');
const { verify } = require('./verify');

const usage = `Usage:
  node scripts/saga-recovery/cli.js inspect --environment <profile> --order-id <id>
  node scripts/saga-recovery/cli.js plan --environment <profile> --order-id <id> --action replay-existing
  node scripts/saga-recovery/cli.js verify --environment <profile> --order-id <id>
Set SAGA_RECOVERY_CONFIG to an absolute owner-only JSON profile path. No execution is supported.`;

function parseArguments(args) {
  const [command, ...rest] = args;
  if (!['inspect', 'plan', 'verify'].includes(command)) throw fail('UNSUPPORTED_COMMAND');
  const allowed = command === 'plan' ? ['--environment', '--order-id', '--action'] : ['--environment', '--order-id'];
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!allowed.includes(key) || Object.hasOwn(options, key) || !value || value.startsWith('--')) throw fail('INVALID_ARGUMENTS');
    options[key] = value;
  }
  if (!options['--environment']) throw fail('ENVIRONMENT_REQUIRED');
  if (!options['--order-id']) throw fail('ORDER_ID_REQUIRED');
  if (command === 'plan' && !options['--action']) throw fail('ACTION_REQUIRED');
  return { command, environment: options['--environment'], orderId: validateOrderId(options['--order-id']), action: options['--action'] };
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || (value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`));
  if (args.length === 1 && args[0] === '--help') { (dependencies.help || console.log)(usage); return 0; }
  try {
    const options = parseArguments(args);
    const profile = (dependencies.loadProfile || loadProfile)(options.environment);
    const snapshot = await (dependencies.inspect || inspect)(profile, options.orderId);
    if (options.command === 'plan') {
      const artifact = plan(snapshot, options.action);
      output(artifact);
      return artifact.status === 'BLOCKED' ? 2 : 0;
    }
    const verification = verify(snapshot);
    output(options.command === 'inspect' ? { ...publicInspection(snapshot), verification } : {
      environment: snapshot.environment, orderId: snapshot.orderId, crossDatabaseSnapshot: 'NON_ATOMIC', verification });
    return options.command === 'verify' && verification.status === 'CONFLICT' ? 2 : 0;
  } catch (error) {
    if (error.code === 'UNSUPPORTED_JSON_PRECISION') { output({ error: 'UNSUPPORTED_JSON_PRECISION', status: 'BLOCKED', executionSupported: false }); return 2; }
    // Never print raw pg/fs/JSON errors, stack traces, paths or connection details.
    const safeCodes = new Set(['ENVIRONMENT_REQUIRED', 'ORDER_ID_REQUIRED', 'ACTION_REQUIRED', 'INVALID_ORDER_ID',
      'INVALID_ARGUMENTS', 'UNSUPPORTED_COMMAND', 'INVALID_ENVIRONMENT', 'INVALID_PROFILE', 'INVALID_CONFIG',
      'UNKNOWN_ENVIRONMENT', 'UNSUPPORTED_ENVIRONMENT_KIND', 'INVALID_DATABASE_CONFIGURATION',
      'UNSAFE_DATABASE_CONFIGURATION', 'UNSAFE_TEST_TARGET', 'AMBIGUOUS_DATABASE_TARGETS',
      'EXPLICIT_CONFIG_PATH_REQUIRED', 'UNSAFE_CONFIG_FILE', 'CONFIG_UNAVAILABLE_OR_INVALID', 'DATABASE_IDENTITY_OR_ROLE_MISMATCH']);
    output({ error: safeCodes.has(error.code) ? error.code : 'INSPECTION_FAILED', executionSupported: false });
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
module.exports = { main, parseArguments };
