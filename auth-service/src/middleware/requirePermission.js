function requirePermission(permission) {
  return (req, res, next) => {
    const permissions = req.auth?.payload?.permissions || [];

    if (!permissions.includes(permission)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
      });
    }

    next();
  };
}

module.exports = requirePermission;
