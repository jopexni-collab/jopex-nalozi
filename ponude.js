const express = require('express');
const router = express.Router();
const pool = require('./db');

// GET /api/ponude — lista ponuda (moje ili sve za admina)
router.get('/', async (req, res) => {
  const u = req.session?.user;
  if (!u) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const r = await pool.query(
      `SELECT id, naziv, kupac, kreator_id, kreator_inicijali, datum, link_json, kreirano
       FROM ponude
       WHERE ($1 = 'admin' OR kreator_id = $2)
       ORDER BY kreirano DESC
       LIMIT 100`,
      [u.rola, u.id]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

// POST /api/ponude — upis metapodataka nakon R2 uploada
router.post('/', async (req, res) => {
  const u = req.session?.user;
  if (!u) return res.status(401).json({ error: 'Niste prijavljeni.' });
  const { naziv, kupac, link_json } = req.body;
  if (!naziv) return res.status(400).json({ error: 'naziv je obavezan.' });
  try {
    const inicijali = u.ime_prezime.split(' ').map(d => d[0]).join('').toUpperCase();
    const r = await pool.query(
      `INSERT INTO ponude (naziv, kupac, kreator_id, kreator_inicijali, link_json)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [naziv, kupac || null, u.id, inicijali, link_json || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

// DELETE /api/ponude/:id — brisanje (samo kreator ili admin)
router.delete('/:id', async (req, res) => {
  const u = req.session?.user;
  if (!u) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const r = await pool.query(
      `DELETE FROM ponude WHERE id = $1 AND ($2 = 'admin' OR kreator_id = $3) RETURNING id`,
      [req.params.id, u.rola, u.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

module.exports = router;
