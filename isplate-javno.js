// isplate-javno.js
// JAVNA (bez prijave) ruta za dokument "Potvrda o isplati" koji dobija primalac novca.
// Za razliku od otpremnice-javno.js (koja NAMJERNO ne pokazuje cijene jer ide kupcu kao
// otpremnica robe), ovdje je iznos SUŠTINA dokumenta — to je potvrda da je JoPeX isplatio
// tačno taj iznos toj osobi, iz tog razloga. Pristup preko nagađanju otpornog tokena.
const express = require('express');
const router = express.Router();
const pool = require('./db');

const RAZLOG_LABEL = {
  povrat_komitentu: 'Povrat komitentu', gorivo: 'Gorivo', sitne_popravke: 'Sitne popravke',
  dorucak: 'Trošak doručka', cistac: 'Trošak čistača', servis: 'Servis', drugo: 'Drugo',
};

// GET /api/isplate-javno/:token
router.get('/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length < 10) return res.status(404).json({ error: 'Nije pronađeno.' });

    const r = await pool.query(
      `SELECT id, iznos, razlog, napomena, primalac_ime, objekt_naziv, komercijalista_ime, datum
       FROM isplate WHERE javni_token=$1`,
      [token]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Isplata nije pronađena.' });
    const isp = r.rows[0];

    res.json({
      broj: `ISP-${isp.id}`,
      datum: isp.datum,
      iznos: isp.iznos,
      razlog: isp.razlog,
      razlog_label: RAZLOG_LABEL[isp.razlog] || isp.razlog,
      napomena: isp.napomena,
      primalac_ime: isp.primalac_ime,
      objekt_naziv: isp.objekt_naziv,
      komercijalista_ime: isp.komercijalista_ime,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
