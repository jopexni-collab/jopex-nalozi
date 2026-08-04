const express = require('express');
const router = express.Router();
const pool = require('./db');

// Admin uvijek prolazi; ostali moraju imati moze_prodavati, komercijalista_teren, ili
// moze_ugovarati (potrebno i terencu i "Ponude robe" korisnicima za listu PJ-ova).
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati || u?.komercijalista_teren || u?.moze_ugovarati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
});

// GET /api/prodajni-objekti/kupci-grupe - lista grupa kupaca (za admin podešavanje po PJ
// — npr. "BiH" vs "Niš (Srbija)"). MORA biti prije "/:id" ispod.
router.get('/kupci-grupe', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM kupci_grupe ORDER BY naziv');
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prodajni-objekti/za-maloprodaju - ISTO kao GET / ali FILTRIRANO na PJ za koje
// je korisnik konkretno ovlašćen (prodavci_pj) — koristi SAMO maloprodaja.html birač PJ.
// Ostali potrošači ove rute (Kalkulacija, Roba/magacin...) i dalje koriste GET / (svi PJ),
// jer imaju SVOJU logiku pristupa (moze_roba_magacin itd.), ne vezanu za maloprodaju.
// SIGURNOSNA NAPOMENA: ako korisnik NEMA nijedan zapis u prodavci_pj (admin ga nikad nije
// eksplicitno ograničio), vidi SVE PJ — isto kao ranije (opt-in ograničenje, ne bi trebalo
// iznenada zaključati postojeće komercijaliste dok ih admin svjesno ne ograniči).
router.get('/za-maloprodaju', async (req, res) => {
  try {
    const u = req.session?.user;
    if (u?.rola === 'admin') {
      const r = await pool.query('SELECT * FROM prodajni_objekti WHERE aktivan=true ORDER BY naziv');
      return res.json(r.rows);
    }
    const dodijeljeni = await pool.query('SELECT objekat_id FROM prodavci_pj WHERE zaposleni_id=$1', [u.id]);
    if (!dodijeljeni.rows.length) {
      const r = await pool.query('SELECT * FROM prodajni_objekti WHERE aktivan=true ORDER BY naziv');
      return res.json(r.rows);
    }
    const idjevi = dodijeljeni.rows.map(row => row.objekat_id);
    const r = await pool.query(
      'SELECT * FROM prodajni_objekti WHERE aktivan=true AND id = ANY($1::int[]) ORDER BY naziv',
      [idjevi]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prodajni-objekti - lista aktivnih (za birač u maloprodaji)
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM prodajni_objekti WHERE aktivan=true ORDER BY naziv'
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prodajni-objekti - novi PJ (samo admin)
router.post('/', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može dodavati prodajne objekte.' });
  try {
    const { naziv, adresa } = req.body;
    if (!naziv || !naziv.trim()) return res.status(400).json({ error: 'Naziv PJ je obavezan.' });
    const r = await pool.query(
      `INSERT INTO prodajni_objekti (naziv, adresa) VALUES ($1,$2) RETURNING *`,
      [naziv.trim(), adresa || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/prodajni-objekti/:id - izmjena (samo admin)
router.patch('/:id', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može mijenjati prodajne objekte.' });
  try {
    const { naziv, adresa, aktivan, email_knjigovodstvo, valuta, telefon_knjigovodstvo, kupci_grupa_id } = req.body;
    const r = await pool.query(
      `UPDATE prodajni_objekti SET
         naziv=COALESCE($1,naziv), adresa=COALESCE($2,adresa), aktivan=COALESCE($3,aktivan),
         email_knjigovodstvo=COALESCE($4,email_knjigovodstvo), valuta=COALESCE($5,valuta),
         telefon_knjigovodstvo=COALESCE($6,telefon_knjigovodstvo),
         kupci_grupa_id=COALESCE($8,kupci_grupa_id)
       WHERE id=$7 RETURNING *`,
      [naziv, adresa, aktivan, email_knjigovodstvo, valuta, telefon_knjigovodstvo, req.params.id, kupci_grupa_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
