// middleware/requireLogin.js
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  }
  next();
}
module.exports = requireLogin;
