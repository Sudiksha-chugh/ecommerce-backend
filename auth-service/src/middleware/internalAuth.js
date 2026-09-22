const crypto = require('crypto');

function authenticateInternalService(req, res, next) {
  const providedKey = req.headers['x-internal-service-key'];
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;

  if (!providedKey || !expectedKey) {
    return res.status(401).json({
      error: 'Invalid internal service credentials',
    });
  }

  const providedBuffer = Buffer.from(providedKey);
  const expectedBuffer = Buffer.from(expectedKey);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return res.status(401).json({
      error: 'Invalid internal service credentials',
    });
  }

  next();
}

module.exports = authenticateInternalService;
