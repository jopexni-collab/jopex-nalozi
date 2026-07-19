const express = require('express');
const router = express.Router();
const pool = require('./db');

// GET /api/gotovina - lista svih uplata
router.get('/', async (req, res) => {
  try {
    const { od, do: do_, primio, izvor, nepredano } = req.query;
    let where = [];
    let vals = [];
    let i = 1;
    if (od) { where.push(`datum >= $${i++}`); vals.push(od); }
    if (do_) { where.push(`datum <= $${i++}`); vals.push(do_); }
    if (primio) { where.push(`primio = $${i++}`); vals.push(primio); }
    if (izvor) { where.push(`izvor = $${i++}`); vals.push(izvor); }
    if (nepredano === 'true') { where.push(`predao_blagajniku = false`); }
    // "Nalog/Otp" kolona (g.nalog_r_br) sad drži i broj radnog naloga i broj otpremnice iz
    // maloprodaje (tekst, npr. "OTP-2026-000123") — zato je tip kolone VARCHAR. Ovdje se
    // poredi kao tekst (p.r_br::text), inače bi Postgres bacio grešku tipa na ne-brojčane
    // vrijednosti (otpremnica brojevi). Za redove sa OTP brojem JOIN jednostavno neće naći
    // poklapanje (narucilac/zadatak ostaju NULL), što je ispravno ponašanje.
    const sql = `SELECT g.*, p.narucilac, p.zadatak
      FROM gotovina g
      LEFT JOIN proizvodnja_jopex p ON g.nalog_r_br = p.r_br::text
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY g.datum DESC, g.kreirano DESC`;
    const r = await pool.query(sql, vals);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gotovina/suma - suma po danu/sedmici/mjesecu
router.get('/suma', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT 
        SUM(iznos) FILTER (WHERE datum = CURRENT_DATE) AS danas,
        SUM(iznos) FILTER (WHERE datum >= date_trunc('week', CURRENT_DATE)) AS ova_sedmica,
        SUM(iznos) FILTER (WHERE date_trunc('month', datum) = date_trunc('month', CURRENT_DATE)) AS ovaj_mjesec,
        SUM(iznos) FILTER (WHERE predao_blagajniku = false) AS nepredano
      FROM gotovina
    `);
    // Očekivano od (radnih) naloga — zbir "za naplatu" (ugovorena_suma - avans) preko svih
    // naloga koji još nisu u potpunosti naplaćeni. Logično se smanjuje kad se nešto naplati
    // (avans/naplaceno_opis se ažurira u proizvodnja.js, za_naplatu prati taj pad automatski).
    let ocekivanoNalozi = 0;
    try {
      const rn = await pool.query(`
        SELECT COALESCE(SUM(GREATEST(COALESCE(ugovorena_suma,0) - COALESCE(avans,0), 0)),0) AS ukupno
        FROM proizvodnja_jopex
      `);
      ocekivanoNalozi = parseFloat(rn.rows[0].ukupno) || 0;
    } catch (e) { /* tabela/kolona se možda razlikuje — ne rušimo cijelu rutu zbog ovoga */ }

    // Očekivano od maloprodaje — zbir svih neplaćenih/djelimično plaćenih otpremnica.
    let ocekivanoMalo = 0;
    try {
      const rm = await pool.query(`
        SELECT COALESCE(SUM(ukupan_iznos - iznos_placeno),0) AS ukupno
        FROM otpremnice WHERE status='potvrdjena' AND status_placanja != 'placeno'
      `);
      ocekivanoMalo = parseFloat(rm.rows[0].ukupno) || 0;
    } catch (e) { /* isto — ne rušimo rutu ako tabela/kolona iz nekog razloga ne postoji */ }

    res.json({ ...r.rows[0], ocekivano_nalozi: ocekivanoNalozi.toFixed(2), ocekivano_malo: ocekivanoMalo.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gotovina/nalog/:r_br - uplate za konkretan nalog
router.get('/nalog/:r_br', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM gotovina WHERE nalog_r_br=$1 ORDER BY datum DESC',
      [req.params.r_br]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gotovina - nova uplata
router.post('/', async (req, res) => {
  try {
    const { datum, iznos, primio, izvor, nalog_r_br, opis } = req.body;
    if (!iznos || !primio) return res.status(400).json({ error: 'iznos i primio su obavezni.' });
    const r = await pool.query(
      `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [datum || new Date().toISOString().split('T')[0], iznos, primio,
       izvor || 'Proizvodnja', nalog_r_br || null, opis || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/gotovina/:id - ažuriranje (predao vlasniku)
router.patch('/:id', async (req, res) => {
  try {
    const { predao_blagajniku, datum_predaje, iznos, primio, datum, opis, izvor, nalog_r_br } = req.body;
    const sets = [], vals = [];
    let i = 1;
    const ALLOWED = ['predao_blagajniku','datum_predaje','iznos','primio','datum','opis','izvor','nalog_r_br'];
    for (const k of ALLOWED) {
      if (k in req.body) { sets.push(`${k}=$${i++}`); vals.push(req.body[k]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nema polja.' });
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE gotovina SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/gotovina/:id
router.delete('/:id', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    await pool.query('DELETE FROM gotovina WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
