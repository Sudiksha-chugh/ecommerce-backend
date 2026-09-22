const crypto = require('crypto');
const { execFileSync } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, resolve);
      return;
    }

    process.stdout.write(question);

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    let value = '';

    const onData = (data) => {
      const char = data.toString();

      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }

      if (char === '\u0003') {
        process.exit(130);
      }

      if (char === '\u007f') {
        value = value.slice(0, -1);
        return;
      }

      value += char;
    };

    stdin.on('data', onData);
  });
}

function applySecret(name, literals) {
  const args = ['create', 'secret', 'generic', name];

  for (const [key, value] of Object.entries(literals)) {
    args.push(`--from-literal=${key}=${value}`);
  }

  args.push('--dry-run=client', '-o', 'yaml');

  const yaml = execFileSync('kubectl', args, {
    encoding: 'utf8',
  });

  execFileSync('kubectl', ['apply', '-f', '-'], {
    input: yaml,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

async function main() {
  const context = execFileSync(
    'kubectl',
    ['config', 'current-context'],
    { encoding: 'utf8' }
  ).trim();

  if (context !== 'docker-desktop') {
    throw new Error(
      `Expected Kubernetes context "docker-desktop", found "${context}".`
    );
  }

  console.log('Creating Kubernetes Secrets in docker-desktop.');
  console.log(
    'Secret values are entered interactively and are not stored in this script.'
  );
  console.log();

  let jwtCurrentSecret = await ask(
    'JWT current secret (press Enter to generate one): ',
    true
  );

  if (!jwtCurrentSecret) {
    jwtCurrentSecret = crypto.randomBytes(48).toString('base64url');
  }

  const jwtPreviousSecret = await ask(
    'JWT previous secret (press Enter if none): ',
    true
  );

  if (
    jwtPreviousSecret &&
    jwtPreviousSecret === jwtCurrentSecret
  ) {
    throw new Error(
      'JWT previous secret must be different from JWT current secret.'
    );
  }

  let internalServiceKey = await ask(
    'Internal service key (press Enter to generate one): ',
    true
  );

  if (!internalServiceKey) {
    internalServiceKey = crypto.randomBytes(32).toString('hex');
  }

  const authDbPassword = await ask('Auth DB password: ', true);
  const catalogDbPassword = await ask('Catalog DB password: ', true);
  const ordersDbPassword = await ask('Orders DB password: ', true);
  const paymentsDbPassword = await ask('Payments DB password: ', true);

  const rabbitmqUsername = await ask('RabbitMQ username: ');
  const rabbitmqPassword = await ask('RabbitMQ password: ', true);

  if (!rabbitmqUsername) {
    throw new Error('RabbitMQ username cannot be empty.');
  }

  if (!rabbitmqPassword) {
    throw new Error('RabbitMQ password cannot be empty.');
  }

  const rabbitmqUrl =
    `amqp://${encodeURIComponent(rabbitmqUsername)}` +
    `:${encodeURIComponent(rabbitmqPassword)}` +
    '@rabbitmq:5672';

  applySecret('auth-db-secret', {
    POSTGRES_USER: 'auth_user',
    POSTGRES_PASSWORD: authDbPassword,
    POSTGRES_DB: 'auth_db',
  });

  applySecret('auth-service-secret', {
    JWT_CURRENT_SECRET: jwtCurrentSecret,
    JWT_PREVIOUS_SECRET: jwtPreviousSecret,
    DB_USER: 'auth_user',
    DB_PASSWORD: authDbPassword,
    DB_NAME: 'auth_db',
  });

  applySecret('catalog-db-secret', {
    POSTGRES_USER: 'catalog_user',
    POSTGRES_PASSWORD: catalogDbPassword,
    POSTGRES_DB: 'catalog_db',
  });

  applySecret('catalog-service-secret', {
    JWT_CURRENT_SECRET: jwtCurrentSecret,
    JWT_PREVIOUS_SECRET: jwtPreviousSecret,
    DB_USER: 'catalog_user',
    DB_PASSWORD: catalogDbPassword,
    DB_NAME: 'catalog_db',
  });

  applySecret('cart-service-secret', {
    JWT_CURRENT_SECRET: jwtCurrentSecret,
    JWT_PREVIOUS_SECRET: jwtPreviousSecret,
  });

  applySecret('orders-db-secret', {
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: ordersDbPassword,
    POSTGRES_DB: 'orders_db',
  });

  applySecret('orders-service-secret', {
    JWT_CURRENT_SECRET: jwtCurrentSecret,
    JWT_PREVIOUS_SECRET: jwtPreviousSecret,
  });

  applySecret('payments-db-secret', {
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: paymentsDbPassword,
    POSTGRES_DB: 'payments_db',
  });

  applySecret('rabbitmq-secret', {
    username: rabbitmqUsername,
    password: rabbitmqPassword,
    url: rabbitmqUrl,
  });

  applySecret('internal-service-secret', {
    INTERNAL_SERVICE_KEY: internalServiceKey,
  });

  console.log();
  console.log(
    'All Kubernetes Secrets were created or updated successfully.'
  );
}

main()
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    rl.close();
  });
