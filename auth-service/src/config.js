require('dotenv').config();

const MIN_JWT_SECRET_LENGTH = 32;
const INSECURE_DEFAULT_SECRETS = [
  'super-secret-dev-key-change-in-prod',
];

function validateSecret(name, secret, required = true) {
  if (!secret) {
    if (required) {
      throw new Error(`${name} is required`);
    }
    return;
  }

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `${name} must be at least ${MIN_JWT_SECRET_LENGTH} characters long`
    );
  }

  if (INSECURE_DEFAULT_SECRETS.includes(secret)) {
    throw new Error(`${name} must not use a known insecure default value`);
  }
}

function validateJwtConfig() {
  const currentSecret = process.env.JWT_CURRENT_SECRET;
  const previousSecret = process.env.JWT_PREVIOUS_SECRET;

  validateSecret('JWT_CURRENT_SECRET', currentSecret);
  validateSecret('JWT_PREVIOUS_SECRET', previousSecret, false);

  if (
    previousSecret &&
    currentSecret &&
    previousSecret === currentSecret
  ) {
    throw new Error(
      'JWT_PREVIOUS_SECRET must be different from JWT_CURRENT_SECRET'
    );
  }
}

function getJwtSecrets() {
  return {
    current: process.env.JWT_CURRENT_SECRET,
    previous: process.env.JWT_PREVIOUS_SECRET || null,
  };
}

module.exports = {
  validateJwtConfig,
  getJwtSecrets,
};
