// routes/proizvodnja.js
const express = require('express');
const router = express.Router();
const pool = require('./db');

// Finansijske kolone - vide ih samo admini
const ADMIN_COLS = `
  p.ugovorena_suma, p.avans,
  (COALESCE(p.ugovorena_suma,0) - COALESCE(p.avans,0)) AS za_naplatu,
  p.naplata_detalji, p.naplaceno_fakturisano, p.dodatni_rad_napomena
`;

// Tehničke kolone - vide ih svi
const BASE_COLS = `
  p.r_br, p.zadatak, p.prioritet, p.ugovorio_id, p.ugovorio,
  p.narucilac, p.materijal, p.status, p.pocetak, p.planirani_zavrsetak,
  (p.planirani_zavrsetak - CURRENT_DATE) AS broj_dana,
  p.gotovo, p.reklamacija_dodatni_rad, p.napomena,
  p.link_skica, p.link_ponuda, p.datum_kreiranja
`;

// GET /api/proizvodnja - lista (admin vidi finansije, ostali ne)
router.get('/', async (req, res) => {
  const isAdmin = req.session?.user?.rola === 'admin';
  const cols = isAdmin ? BASE_COLS + ',' + ADMIN_COLS : BASE_COLS;
  try {
    const r = await pool.query(
      `SELECT ${cols} FROM proizvodnja_jopex p ORDER BY p.r_br DESC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri učitavanju naloga.' });
  }
});

// GET /api/proizvodnja/:r_br - jedan nalog
router.get('/:r_br', async (req, res) => {
  const isAdmin = req.session?.user?.rola === 'admin';
  const cols = isAdmin ? BASE_COLS + ',' + ADMIN_COLS : BASE_COLS;
  try {
    const r = await pool.query(
      `SELECT ${cols} FROM proizvodnja_jopex p WHERE p.r_br = $1`,
      [req.params.r_br]
    );
    if (!r.rows.length)
      return res.status(404).json({ error: 'Nalog nije pronađen.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Greška.' });
  }
});

// POST /api/proizvodnja - novi nalog
// Poziva se i iz web forme i iz JoPeX HTML (usvajanje ponude)
router.post('/', async (req, res) => {
  const {
    zadatak, prioritet, ugovorio_id, ugovorio: ugovorioIzReq, narucilac, materijal, status,
    pocetak, planirani_zavrsetak, napomena, link_skica, link_ponuda,
    ugovorena_suma, avans,
  } = req.body || {};

  if (!zadatak?.trim())
    return res.status(400).json({ error: '"zadatak" je obavezno polje.' });

  try {
    let ugovorioIme = ugovorioIzReq || null;
    if (ugovorio_id) {
      const emp = await pool.query(
        `SELECT ime_prezime FROM zaposleni
         WHERE id = $1 AND aktivan = true`,
        [ugovorio_id]
      );
      if (emp.rows.length) ugovorioIme = emp.rows[0].ime_prezime;
    }

    const r = await pool.query(
      `INSERT INTO proizvodnja_jopex
        (zadatak, prioritet, ugovorio_id, ugovorio, narucilac, materijal,
         status, pocetak, planirani_zavrsetak, napomena, link_skica,
         link_ponuda, ugovorena_suma, avans)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING r_br, zadatak, narucilac, ugovorena_suma, status`,
      [
        zadatak, prioritet || 'Normal',
        ugovorio_id || null, ugovorioIme,
        narucilac || null, materijal || null,
        status || 'Nije Započeto',
        pocetak || null, planirani_zavrsetak || null,
        napomena || null, link_skica || null, link_ponuda || null,
        ugovorena_suma ?? 0, avans ?? 0,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri upisu: ' + err.message });
  }
});

// PATCH /api/proizvodnja/:r_br - djelimično ažuriranje
router.patch('/:r_br', async (req, res) => {
  const isAdmin = req.session?.user?.rola === 'admin';

  // Tehničke kolone - mijenjaju svi
  const ALLOWED_BASE = [
    'zadatak','prioritet','narucilac','materijal','status','pocetak',
    'planirani_zavrsetak','gotovo','reklamacija_dodatni_rad','napomena',
    'link_skica','link_ponuda',
  ];
  // Finansijske kolone - mijenjaju samo admini
  const ALLOWED_ADMIN = [
    'ugovorena_suma','avans','naplata_detalji',
    'naplaceno_fakturisano','dodatni_rad_napomena',
  ];

  const allowed = isAdmin ? [...ALLOWED_BASE, ...ALLOWED_ADMIN] : ALLOWED_BASE;
  const sets = [], vals = [];
  let i = 1;

  for (const key of allowed) {
    if (key in req.body) { sets.push(`${key} = $${i++}`); vals.push(req.body[key]); }
  }

  // Poseban slučaj: ugovorio_id (treba validaciju + upisati i ugovorio tekst)
  if (req.body.ugovorio_id !== undefined) {
    let ugovorioIme = null;
    if (req.body.ugovorio_id) {
      const emp = await pool.query(
        `SELECT ime_prezime FROM zaposleni WHERE id=$1 AND moze_ugovarati=true AND aktivan=true`,
        [req.body.ugovorio_id]
      );
      if (!emp.rows.length)
        return res.status(400).json({ error: 'Osoba ne može biti "Ugovorio".' });
      ugovorioIme = emp.rows[0].ime_prezime;
    }
    sets.push(`ugovorio_id = $${i++}`); vals.push(req.body.ugovorio_id || null);
    sets.push(`ugovorio = $${i++}`);    vals.push(ugovorioIme);
  }

  if (!sets.length)
    return res.status(400).json({ error: 'Nema polja za izmjenu.' });

  vals.push(req.params.r_br);
  try {
    const r = await pool.query(
      `UPDATE proizvodnja_jopex SET ${sets.join(', ')} WHERE r_br = $${i} RETURNING r_br, status`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri ažuriranju: ' + err.message });
  }
});

module.exports = router;
