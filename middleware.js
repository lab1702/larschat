const { findSession } = require('./auth');

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = findSession(token);

  if (!session) {
    res.clearCookie('session');
    return res.status(401).json({ error: 'Session expired' });
  }

  req.name = session.name;
  next();
}

module.exports = { requireAuth };
