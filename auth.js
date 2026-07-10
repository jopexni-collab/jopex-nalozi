const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('./db');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email i lozinka su obavezni.' });
  try {
    const r = await pool.query(
      `SELECT id, ime_prezime, email, lozinka, rola, aktivan
       FROM zaposleni WHERE LOWER(email) = LOWER($1)`,
      [String(email).trim()]
    );
    if (!r.rows.length)
      return res.status(401).json({ error: 'Pogrešan email ili lozinka.' });
    const user = r.rows[0];
    if (!user.aktivan)
      return res.status(403).json({ error: 'Nalog je deaktiviran.' });
    const ok = await bcrypt.compare(password, user.lozinka || '');
    if (!ok)
      return res.status(401).json({ error: 'Pogrešan email ili lozinka.' });
    req.session.user = {
      id: user.id, ime_prezime: user.ime_prezime,
      email: user.email, rola: user.rola,
    };
    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri prijavi.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session?.user)
    return res.status(401).json({ error: 'Niste prijavljeni.' });
  res.json(req.session.user);
});

module.exports = router;
