function requestIdMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'];

  req.requestId = requestId || null;

  next();
}

module.exports = requestIdMiddleware;

