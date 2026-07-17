// otpremnice-javno.js
// JAVNA (bez prijave) ruta za dokument otpremnice koji dobija kupac.
// NAMJERNO ne vraća nikakve cijene/iznose/podatke o plaćanju — samo ono što
// otpremnica kao dokument treba da sadrži: memorandum, kupac, stavke (šifra/
// naziv/količina/jed. mjere). Pristup je preko nagađanju otpornog tokena
// (javni_token), ne preko sekvencijalnog ID-ja.
const express = require('express');
const router = express.Router();
const pool = require('./db');

// GET /api/otpremnice-javno/:token
router.get('/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length < 10) return res.status(404).json({ error: 'Nije pronađeno.' });

    const h = await pool.query(
      `SELECT broj, datum, kupac_naziv, kupac_adresa, kupac_grad, objekt_naziv, komercijalista_ime, status
       FROM otpremnice WHERE javni_token=$1`,
      [token]
    );
    if (!h.rows.length) return res.status(404).json({ error: 'Otpremnica nije pronađena.' });
    const otp = h.rows[0];

    const s = await pool.query(
      `SELECT sifra, naziv, jed_mjera, kolicina, duzina_cm, visina_cm, debljina_cm, broj_komada
       FROM otpremnica_stavke
       WHERE otpremnica_id = (SELECT id FROM otpremnice WHERE javni_token=$1)
       ORDER BY id`,
      [token]
    );

    // Eksplicitno: NEMA cijena, iznosa, ukupnog iznosa, niti bilo čega finansijskog u ovom odgovoru.
    res.json({
      broj: otp.broj,
      datum: otp.datum,
      kupac_naziv: otp.kupac_naziv,
      kupac_adresa: otp.kupac_adresa,
      kupac_grad: otp.kupac_grad,
      objekt_naziv: otp.objekt_naziv,
      komercijalista_ime: otp.komercijalista_ime,
      stavke: s.rows.map((r, i) => ({
        rb: i + 1, sifra: r.sifra, naziv: r.naziv, jed_mjera: r.jed_mjera, kolicina: r.kolicina,
        duzina_cm: r.duzina_cm, visina_cm: r.visina_cm, debljina_cm: r.debljina_cm, broj_komada: r.broj_komada,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
