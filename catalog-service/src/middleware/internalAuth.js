function authenticateInternalService(req, res, next) {
  const key = req.headers['x-internal-service-key'];

  if (!key || key !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({
      error: 'Invalid internal service credentials',
    });
  }

  next();
}

module.exports = authenticateInternalService;
