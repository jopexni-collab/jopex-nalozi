const express = require('express');
const router = express.Router();
const { pretraziKupce, kreirajKupca } = require('./kupci-lib');

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true (dozvola iz korisnici.html).
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
});

// GET /api/kupci?q=pretraga&limit=20 - pretraga po nazivu ili telefonu (samo aktivni)
router.get('/', async (req, res) => {
  try {
    const rows = await pretraziKupce(req.query.q, req.query.limit);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kupci - novi kupac (slobodan unos kad se ne pronađe u pretrazi)
router.post('/', async (req, res) => {
  try {
    const kupac = await kreirajKupca(req.body);
    res.status(201).json(kupac);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
