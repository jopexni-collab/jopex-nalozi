const express = require('express');
const router = express.Router();
const pool = require('./db');
const bcrypt = require('bcryptjs');

// GET /api/zaposleni/ugovaraci - lista onih koji mogu ugovarati (javna ruta za JoPeX)
router.get('/ugovaraci', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, ime_prezime FROM zaposleni
       WHERE moze_ugovarati = true AND aktivan = true ORDER BY ime_prezime`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Greška.' });
  }
});

// GET /api/zaposleni - lista svih zaposlenih (samo admin)
router.get('/', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const r = await pool.query(
      `SELECT id, ime_prezime, pozicija, rola, aktivan,
              moze_ugovarati, unos_naloga, izmjena_statusa, izmjena_naloga, email
       FROM zaposleni ORDER BY ime_prezime`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Greška.' });
  }
});

// PATCH /api/zaposleni/:id - izmjena prava (samo admin)
router.patch('/:id', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  const ALLOWED = ['rola','aktivan','moze_ugovarati','unos_naloga','izmjena_statusa','izmjena_naloga','email'];
  const sets=[], vals=[];
  let i=1;
  for(const key of ALLOWED){
    if(key in req.body){ sets.push(`${key}=$${i++}`); vals.push(req.body[key]); }
  }
  if(!sets.length) return res.status(400).json({ error: 'Nema polja.' });
  vals.push(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE zaposleni SET ${sets.join(',')} WHERE id=$${i} RETURNING id`,
      vals
    );
    if(!r.rows.length) return res.status(404).json({ error: 'Nije pronađen.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

// POST /api/zaposleni/:id/lozinka - postavljanje lozinke (samo admin)
router.post('/:id/lozinka', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  const { lozinka } = req.body;
  if (!lozinka || lozinka.length < 6)
    return res.status(400).json({ error: 'Lozinka prekratka.' });
  try {
    const hash = await bcrypt.hash(lozinka, 10);
    await pool.query('UPDATE zaposleni SET lozinka=$1 WHERE id=$2', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška.' });
  }
});

module.exports = router;
