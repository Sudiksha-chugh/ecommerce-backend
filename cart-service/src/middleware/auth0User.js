const checkAuth0Token = require('./auth0');

async function authenticateAuth0User(req, res, next) {
  try {
    await new Promise((resolve, reject) => {
      checkAuth0Token(req, res, (err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });

    const sub = req.auth?.payload?.sub;

    if (!sub) {
      return res.status(401).json({
        error: 'Invalid Auth0 identity',
      });
    }

    const response = await fetch(
      `${process.env.AUTH_SERVICE_URL}/internal/users/by-auth0-sub?sub=${encodeURIComponent(sub)}`,
      {
        headers: {
          'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY,
        },
      }
    );

    if (response.status === 404) {
      return res.status(403).json({
        error: 'User identity is not mapped',
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        error: 'Identity service unavailable',
      });
    }

    const user = await response.json();

    req.user = {
      userId: user.id,
      email: user.email,
      role: user.role,
      auth0Sub: sub,
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = authenticateAuth0User;