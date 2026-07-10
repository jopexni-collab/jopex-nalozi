// routes/config.js
// GET /api/config  — vraća sve što JoPeX HTML keširа lokalno:
//   materijali (sa cijenama), kupci, vrste_obrade, ugovarači
// JoPeX povuče ovo pri otvaranju (kad ima internet), pa čuva u localStorage.
// Kad nema interneta, koristi zadnje poznate podatke.
// NEMA auth zaštite (ali nema ni osjetljivih podataka ovdje) - tako JoPeX
// može povući config i bez prijave (offline-first pristup).

const express = require('express');
const router = express.Router();
const pool = require('./db');

router.get('/', async (req, res) => {
  try {
    const [mat, kupci, obrade, ugovaraci] = await Promise.all([
      pool.query(`SELECT id, naziv, cijena_m2 FROM materijali
                  WHERE aktivan = true ORDER BY naziv`),
      pool.query(`SELECT id, naziv, telefon, adresa, email FROM kupci
                  WHERE aktivan = true ORDER BY naziv`),
      pool.query(`SELECT id, naziv, kod, cijena_m FROM vrste_obrade
                  WHERE aktivan = true ORDER BY id`),
      pool.query(`SELECT id, ime_prezime FROM zaposleni
                  WHERE moze_ugovarati = true AND aktivan = true
                  ORDER BY ime_prezime`),
    ]);
    res.json({
      version: Date.now(), // JoPeX koristi ovo da zna je li config svjež
      materijali:    mat.rows,
      kupci:         kupci.rows,
      vrste_obrade:  obrade.rows,
      ugovaraci:     ugovaraci.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri učitavanju konfiguracije.' });
  }
});

// CRUD za materijale (admin)
router.get('/materijali', async (req, res) => {
  const r = await pool.query(`SELECT * FROM materijali ORDER BY naziv`);
  res.json(r.rows);
});
router.post('/materijali', async (req, res) => {
  const { naziv, cijena_m2, napomena } = req.body;
  if (!naziv) return res.status(400).json({ error: 'Naziv je obavezan.' });
  const r = await pool.query(
    `INSERT INTO materijali (naziv, cijena_m2, napomena) VALUES ($1,$2,$3) RETURNING *`,
    [naziv, cijena_m2 || 0, napomena || null]
  );
  res.status(201).json(r.rows[0]);
});
router.patch('/materijali/:id', async (req, res) => {
  const { naziv, cijena_m2, napomena, aktivan } = req.body;
  const r = await pool.query(
    `UPDATE materijali SET
       naziv = COALESCE($1, naziv),
       cijena_m2 = COALESCE($2, cijena_m2),
       napomena = COALESCE($3, napomena),
       aktivan = COALESCE($4, aktivan)
     WHERE id = $5 RETURNING *`,
    [naziv, cijena_m2, napomena, aktivan, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
  res.json(r.rows[0]);
});

// CRUD za kupce (admin)
router.get('/kupci', async (req, res) => {
  const r = await pool.query(`SELECT * FROM kupci ORDER BY naziv`);
  res.json(r.rows);
});
router.post('/kupci', async (req, res) => {
  const { naziv, telefon, adresa, email, napomena } = req.body;
  if (!naziv) return res.status(400).json({ error: 'Naziv je obavezan.' });
  const r = await pool.query(
    `INSERT INTO kupci (naziv, telefon, adresa, email, napomena)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [naziv, telefon||null, adresa||null, email||null, napomena||null]
  );
  res.status(201).json(r.rows[0]);
});
router.patch('/kupci/:id', async (req, res) => {
  const { naziv, telefon, adresa, email, napomena, aktivan } = req.body;
  const r = await pool.query(
    `UPDATE kupci SET
       naziv   = COALESCE($1, naziv),
       telefon = COALESCE($2, telefon),
       adresa  = COALESCE($3, adresa),
       email   = COALESCE($4, email),
       napomena= COALESCE($5, napomena),
       aktivan = COALESCE($6, aktivan)
     WHERE id = $7 RETURNING *`,
    [naziv, telefon, adresa, email, napomena, aktivan, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
  res.json(r.rows[0]);
});

// Cijene obrade (admin)
router.patch('/vrste_obrade/:id', async (req, res) => {
  const { cijena_m, aktivan } = req.body;
  const r = await pool.query(
    `UPDATE vrste_obrade SET
       cijena_m = COALESCE($1, cijena_m),
       aktivan  = COALESCE($2, aktivan)
     WHERE id = $3 RETURNING *`,
    [cijena_m, aktivan, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
  res.json(r.rows[0]);
});

module.exports = router;
