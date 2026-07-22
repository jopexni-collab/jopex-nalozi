const express = require('express');
const router = express.Router();
const pool = require('./db');

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true.
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
});

// GET /api/prodajni-objekti - lista aktivnih (za birač u maloprodaji)
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM prodajni_objekti WHERE aktivan=true ORDER BY naziv'
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prodajni-objekti - novi PJ (samo admin)
router.post('/', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može dodavati prodajne objekte.' });
  try {
    const { naziv, adresa } = req.body;
    if (!naziv || !naziv.trim()) return res.status(400).json({ error: 'Naziv PJ je obavezan.' });
    const r = await pool.query(
      `INSERT INTO prodajni_objekti (naziv, adresa) VALUES ($1,$2) RETURNING *`,
      [naziv.trim(), adresa || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/prodajni-objekti/:id - izmjena (samo admin)
router.patch('/:id', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može mijenjati prodajne objekte.' });
  try {
    const { naziv, adresa, aktivan, email_knjigovodstvo, valuta, telefon_knjigovodstvo } = req.body;
    const r = await pool.query(
      `UPDATE prodajni_objekti SET
         naziv=COALESCE($1,naziv), adresa=COALESCE($2,adresa), aktivan=COALESCE($3,aktivan),
         email_knjigovodstvo=COALESCE($4,email_knjigovodstvo), valuta=COALESCE($5,valuta),
         telefon_knjigovodstvo=COALESCE($6,telefon_knjigovodstvo)
       WHERE id=$7 RETURNING *`,
      [naziv, adresa, aktivan, email_knjigovodstvo, valuta, telefon_knjigovodstvo, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
