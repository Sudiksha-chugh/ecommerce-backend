const jwt = require('jsonwebtoken');
const { getJwtSecrets } = require('../config');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Invalid authorization header' });
  }

  const token = authHeader.slice(7);

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const { current, previous } = getJwtSecrets();

  jwt.verify(token, current, { algorithms: ['HS256'] }, (err, payload) => {
    if (!err) {
      req.user = payload;
      return next();
    }

    if (!previous) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    jwt.verify(
      token,
      previous,
      { algorithms: ['HS256'] },
      (previousErr, previousPayload) => {
        if (previousErr) {
          return res.status(401).json({ error: 'Invalid or expired token' });
        }

        req.user = previousPayload;
        next();
      }
    );
  });
}

module.exports = authenticateToken;