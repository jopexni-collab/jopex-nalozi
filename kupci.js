const express = require('express');
const router = express.Router();
const pool = require('./db');
const { pretraziKupce, kreirajKupca } = require('./kupci-lib');

// Admin uvijek prolazi; ostali moraju imati moze_prodavati ILI komercijalista_teren
// (terenac takođe treba da traži/kreira kupce, iz teren.html).
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati || u?.komercijalista_teren) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
});

// Nalazi grupa_id za dati PJ (za odvajanje kupaca — npr. PJ Niš odvojeno od BiH PJ-ova).
// Vraća null ako objekt_id nije proslijeđen ili PJ nema podešenu grupu (tretira se kao
// "vidi sve", bezbjedan podrazumevani izbor dok se grupe eksplicitno ne podese).
async function nadjiGrupuPJ(objektId) {
  if (!objektId) return null;
  try {
    const r = await pool.query('SELECT kupci_grupa_id FROM prodajni_objekti WHERE id=$1', [objektId]);
    return r.rows[0]?.kupci_grupa_id || null;
  } catch (e) { return null; }
}

// GET /api/kupci?q=pretraga&limit=20&objekt_id=X - pretraga po nazivu ili telefonu
// (samo aktivni). objekt_id (opciono) filtrira na grupu kupaca TOG PJ-a.
router.get('/', async (req, res) => {
  try {
    const grupaId = await nadjiGrupuPJ(req.query.objekt_id);
    const rows = await pretraziKupce(req.query.q, req.query.limit, grupaId);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kupci - novi kupac (slobodan unos kad se ne pronađe u pretrazi). Ako je
// poslat objekt_id, novi kupac se automatski veže za grupu TOG PJ-a.
router.post('/', async (req, res) => {
  try {
    const grupaId = await nadjiGrupuPJ(req.body.objekt_id);
    const kupac = await kreirajKupca({ ...req.body, grupa_id: grupaId });
    res.status(201).json(kupac);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
