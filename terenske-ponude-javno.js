// terenske-ponude-javno.js
// JAVNA (bez prijave) ruta za dokument PONUDE koji dobija kupac. Za razliku od
// otpremnice-javno.js (koja NAMJERNO ne prikazuje cijene, jer je to dokument o
// isporuci), ovdje su cijene NAMJERNO uključene — ponuda bez cijene je beskorisna
// kupcu. Pristup preko nagađanju otpornog tokena (javni_token), ne sekvencijalnog ID-ja.
const express = require('express');
const router = express.Router();
const pool = require('./db');

// GET /api/terenske-ponude-javno/:token
router.get('/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length < 10) return res.status(404).json({ error: 'Nije pronađeno.' });

    const h = await pool.query(
      `SELECT p.id, p.datum, p.kupac_naziv, p.kupac_adresa, p.kupac_telefon, p.status,
              p.nacin_placanja, p.valuta, p.paritet, p.paritet_adresa, p.vreme_isporuke,
              p.vazi_do, p.komercijalista_ime, o.naziv AS objekt_naziv
       FROM terenske_ponude p
       LEFT JOIN prodajni_objekti o ON o.id = p.objekt_id
       WHERE p.javni_token=$1`,
      [token]
    );
    if (!h.rows.length) return res.status(404).json({ error: 'Ponuda nije pronađena.' });
    const ponuda = h.rows[0];

    const s = await pool.query(
      `SELECT tip, sifra, naziv, jed_mjera, kolicina, cijena, link_slika, zadatak, materijal,
              napomena_stavka, cijena_proizvodnja
       FROM terenska_ponuda_stavke WHERE ponuda_id=$1 ORDER BY id`,
      [ponuda.id]
    );

    const stavke = s.rows.map((r, i) => ({
      rb: i + 1,
      tip: r.tip,
      sifra: r.sifra, naziv: r.tip === 'lager' ? r.naziv : r.zadatak,
      jed_mjera: r.jed_mjera, kolicina: r.kolicina,
      cijena: r.tip === 'lager' ? r.cijena : r.cijena_proizvodnja,
      iznos: r.tip === 'lager' ? (parseFloat(r.kolicina) * parseFloat(r.cijena)) : parseFloat(r.cijena_proizvodnja || 0),
      link_slika: r.link_slika,
      materijal: r.materijal,
      napomena: r.napomena_stavka,
    }));
    const ukupno = stavke.reduce((sum, x) => sum + (parseFloat(x.iznos) || 0), 0);

    res.json({ ...ponuda, stavke, ukupno: +ukupno.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
