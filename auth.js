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
      `SELECT id, ime_prezime, email, lozinka, rola, aktivan,
              moze_ugovarati, unos_naloga, izmjena_statusa, izmjena_naloga,
              moze_prodavati, moze_roba_magacin
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
      id: user.id,
      ime_prezime: user.ime_prezime,
      email: user.email,
      rola: user.rola,
      moze_ugovarati: user.moze_ugovarati,
      unos_naloga: user.unos_naloga,
      izmjena_statusa: user.izmjena_statusa,
      izmjena_naloga: user.izmjena_naloga,
      moze_prodavati: user.moze_prodavati,
      moze_roba_magacin: user.moze_roba_magacin,
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

// POST /api/auth/verify-password - potvrda lozinke TRENUTNO prijavljenog korisnika, bez
// mijenjanja sesije. Koristi se kao dodatna provjera na osjetljivim mjestima (npr. izbor
// prodajnog objekta u maloprodaji) — da neko slučajno ili namjerno ne generiše prodaju na
// pogrešnom PJ samo zato što je uređaj već ulogovan.
router.post('/verify-password', async (req, res) => {
  if (!req.session?.user)
    return res.status(401).json({ error: 'Niste prijavljeni.' });
  const { password } = req.body || {};
  if (!password)
    return res.status(400).json({ error: 'Unesite lozinku.' });
  try {
    const r = await pool.query('SELECT lozinka FROM zaposleni WHERE id=$1', [req.session.user.id]);
    if (!r.rows.length)
      return res.status(401).json({ error: 'Nalog nije pronađen.' });
    const ok = await bcrypt.compare(password, r.rows[0].lozinka || '');
    if (!ok)
      return res.status(401).json({ error: 'Pogrešna lozinka.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri provjeri.' });
  }
});

module.exports = router;
