// routes/katalog-javno.js
// Javni pristup katalogu — kupac otvara link BEZ prijave. Pristup ide iskljucivo preko
// nasumicnog tokena (isti obrazac kao otpremnice-javno / uplate-javno), ne preko ID-ja,
// pa se ne moze pogoditi mijenjanjem broja u adresi.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { ucitajStavke } = require('./katalog');

// GET /api/katalog-javno/:token
router.get('/:token', async (req, res) => {
  try {
    const k = await pool.query('SELECT * FROM katalozi WHERE javni_token=$1', [req.params.token]);
    if (!k.rows.length) return res.status(404).json({ error: 'Katalog nije pronađen ili je uklonjen.' });
    const kat = k.rows[0];

    // Broji se koliko je puta otvoren — posiljalac vidi da li ga je kupac uopste pogledao.
    pool.query('UPDATE katalozi SET broj_otvaranja = broj_otvaranja + 1 WHERE id=$1', [kat.id])
      .catch(() => {});

    const podaci = await ucitajStavke({
      grupe: kat.grupe || [],
      objekt_id: kat.objekt_id,
      tip_kupca_id: kat.tip_kupca_id,
    });

    // Ako je poslato BEZ cijena, cijene se uklanjaju OVDJE (na serveru) — ne salju se
    // uopste, pa se ne mogu izvuci ni kroz alate pregledaca.
    const stavke = kat.sa_cijenama
      ? podaci.stavke
      : podaci.stavke.map(({ cijena, cijena_bez_pdv, pdv_iznos, ...ostalo }) => ostalo);

    res.json({
      naslov: kat.naslov,
      kupac_naziv: kat.kupac_naziv,
      tip_naziv: kat.tip_naziv,
      prikaz: kat.prikaz,
      sa_cijenama: kat.sa_cijenama,
      sa_pdv: podaci.sa_pdv,
      pdv_stopa: podaci.pdv_stopa,
      kreirao_ime: kat.kreirao_ime,
      kreirano: kat.kreirano,
      stavke,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
