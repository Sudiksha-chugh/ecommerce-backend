require('dotenv').config();

const MIN_JWT_SECRET_LENGTH = 32;
const INSECURE_DEFAULT_SECRETS = [
  'super-secret-dev-key-change-in-prod',
];

function validateJwtConfig() {
  const secret = process.env.JWT_SECRET;

  if (process.env.NODE_ENV === 'test') {
    if (!secret) {
      throw new Error('JWT_SECRET is required in test environment');
    }
    return;
  }

  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long`
    );
  }

  if (INSECURE_DEFAULT_SECRETS.includes(secret)) {
    throw new Error('JWT_SECRET must not use a known insecure default value');
  }
}

module.exports = {
  validateJwtConfig,
};
