// uplate-javno.js
// JAVNA (bez prijave) ruta za dokument "Potvrda o uplati (avans)" koji dobija kupac kad
// mu ostane avans nakon uplate (nakon što se eventualni dug pokrije).
const express = require('express');
const router = express.Router();
const pool = require('./db');

// GET /api/uplate-javno/:token
router.get('/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length < 10) return res.status(404).json({ error: 'Nije pronađeno.' });

    const r = await pool.query(
      `SELECT t.id, t.iznos, t.opis, t.objekt_naziv, t.komercijalista_ime, t.datum,
              k.naziv AS kupac_naziv,
              (SELECT COALESCE(SUM(iznos),0) FROM kupac_transakcije WHERE kupac_id=t.kupac_id) AS saldo
       FROM kupac_transakcije t
       JOIN kupci k ON k.id = t.kupac_id
       WHERE t.javni_token=$1 AND t.tip='avans_uplata'`,
      [token]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Uplata nije pronađena.' });
    const u = r.rows[0];

    res.json({
      broj: `AV-${u.id}`,
      datum: u.datum,
      iznos: u.iznos,
      opis: u.opis,
      kupac_naziv: u.kupac_naziv,
      objekt_naziv: u.objekt_naziv,
      komercijalista_ime: u.komercijalista_ime,
      trenutni_saldo: +parseFloat(u.saldo).toFixed(2),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
