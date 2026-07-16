const express = require('express');
const router = express.Router();
const pool = require('./db');

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true.
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
});

// GET /api/kupci?q=pretraga&limit=20 - pretraga po nazivu ili telefonu
router.get('/', async (req, res) => {
  try {
    const { q, limit } = req.query;
    const lim = Math.min(parseInt(limit) || 20, 50);
    if (!q || !q.trim()) {
      const r = await pool.query('SELECT * FROM kupci ORDER BY kreiran DESC LIMIT $1', [lim]);
      return res.json(r.rows);
    }
    const term = q.trim();
    const r = await pool.query(
      `SELECT * FROM kupci
       WHERE naziv ILIKE $1 OR telefon ILIKE $1
       ORDER BY (naziv ILIKE $2) DESC, naziv
       LIMIT $3`,
      [`%${term}%`, `${term}%`, lim]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kupci - novi kupac (slobodan unos kad se ne pronađe u pretrazi)
router.post('/', async (req, res) => {
  try {
    const { naziv, telefon, grad, adresa, email } = req.body;
    if (!naziv || !naziv.trim()) return res.status(400).json({ error: 'Naziv/ime kupca je obavezno.' });
    const r = await pool.query(
      `INSERT INTO kupci (naziv, telefon, grad, adresa, email)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [naziv.trim(), telefon || null, grad || null, adresa || null, email || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
