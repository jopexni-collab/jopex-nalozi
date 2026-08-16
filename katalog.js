// routes/katalog.js
// ══ KATALOG ZA SLANJE KUPCU ═══════════════════════════════════════════════════════
// Zaposleni (blagajnik / komercijalista / teren) sastavi katalog i posalje link kupcu.
// Cijene se racunaju prema VRSTI KUPCA (tipovi_kupaca) — ista pravila kao svuda, preko
// zajednickog modula cijene.js, da se formula ne prepisuje na dva mjesta.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('./db');
const { izracunajCijenu, pdvStopa } = require('./cijene');

// Svako ko radi sa kupcima moze slati katalog — blagajnik, prodaja, teren, ugovaranje.
// Namjerno siroko: "svako u firmi moze doci u situaciji da nesto proda".
function smijeSlati(req, res, next) {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati || u?.komercijalista_teren ||
      u?.moze_ugovarati || u?.moze_roba_magacin) return next();
  const jeBlagajnik = u?.id != null;
  if (jeBlagajnik) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za slanje kataloga.' });
}

// GET /api/katalog/grupe?objekt_id=X — koje grupe proizvoda uopste postoje u tom lageru
router.get('/grupe', smijeSlati, async (req, res) => {
  try {
    const objektId = parseInt(req.query.objekt_id);
    const r = await pool.query(
      `SELECT r.grupa, COUNT(*) AS broj
       FROM roba r
       JOIN roba_pj rp ON rp.roba_id = r.id ${objektId ? 'AND rp.objekt_id = $1' : ''}
       WHERE r.aktivan = true AND r.grupa IS NOT NULL AND r.grupa <> ''
       GROUP BY r.grupa ORDER BY r.grupa`,
      objektId ? [objektId] : []
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/katalog — sastavi katalog i vrati javni token (link za slanje)
router.post('/', smijeSlati, async (req, res) => {
  const u = req.session.user;
  const { tip_kupca_id, grupe, objekt_id, prikaz, sa_cijenama, naslov, kupac_naziv } = req.body || {};
  if (!Array.isArray(grupe) || !grupe.length)
    return res.status(400).json({ error: 'Izaberite bar jednu grupu proizvoda.' });
  try {
    let tipNaziv = null;
    if (tip_kupca_id) {
      const t = await pool.query('SELECT naziv FROM tipovi_kupaca WHERE id=$1', [tip_kupca_id]);
      tipNaziv = t.rows[0]?.naziv || null;
    }
    const token = crypto.randomBytes(16).toString('hex');
    const r = await pool.query(
      `INSERT INTO katalozi (javni_token, tip_kupca_id, tip_naziv, grupe, objekt_id,
                             prikaz, sa_cijenama, naslov, kupac_naziv, kreirao_id, kreirao_ime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, javni_token`,
      [token, tip_kupca_id || null, tipNaziv, grupe, objekt_id || null,
       prikaz === 'lista' ? 'lista' : 'mreza', sa_cijenama !== false,
       naslov || null, kupac_naziv || null, u.id, u.ime_prezime]
    );
    res.status(201).json({ ok: true, token: r.rows[0].javni_token, id: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/katalog/pregled — sadrzaj PRIJE slanja (da posiljalac vidi sta salje)
router.get('/pregled', smijeSlati, async (req, res) => {
  try {
    const grupe = (req.query.grupe || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!grupe.length) return res.json({ stavke: [] });
    const podaci = await ucitajStavke({
      grupe,
      objekt_id: req.query.objekt_id ? parseInt(req.query.objekt_id) : null,
      tip_kupca_id: req.query.tip_kupca_id ? parseInt(req.query.tip_kupca_id) : null,
    });
    res.json(podaci);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Zajednicko ucitavanje stavki — koriste ga i pregled i javni prikaz.
async function ucitajStavke({ grupe, objekt_id, tip_kupca_id }) {
  let tip = null;
  if (tip_kupca_id) {
    const t = await pool.query('SELECT * FROM tipovi_kupaca WHERE id=$1', [tip_kupca_id]);
    tip = t.rows[0] || null;
  }
  const popusti = await pool.query(
    'SELECT * FROM kolicinski_popusti WHERE tip_kupca_id IS NULL OR tip_kupca_id=$1',
    [tip_kupca_id || null]
  );
  const stopa = await pdvStopa();

  const vals = [grupe];
  let objektUslov = '';
  if (objekt_id) { vals.push(objekt_id); objektUslov = `AND rp.objekt_id = $${vals.length}`; }

  const r = await pool.query(
    `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.grupa, r.debljina_cm,
            rp.cijena AS osnovica, rp.stanje,
            (SELECT COALESCE(thumb_url, url) FROM roba_slike WHERE roba_id=r.id AND glavna=true LIMIT 1) AS slika,
            (SELECT url FROM roba_slike WHERE roba_id=r.id AND glavna=true LIMIT 1) AS slika_puna
     FROM roba r
     JOIN roba_pj rp ON rp.roba_id = r.id ${objektUslov}
     WHERE r.aktivan = true AND r.grupa = ANY($1)
     ORDER BY r.grupa, r.naziv`,
    vals
  );

  // Kupcu se NE prikazuje tacna kolicina — samo da li je dostupno. Zalihe su interna
  // informacija; kupcu je dovoljno da zna moze li kupiti.
  const stavke = r.rows.map(s => {
    const c = izracunajCijenu(s.osnovica, tip, 1, popusti.rows, stopa);
    return {
      id: s.id, sifra: s.sifra, naziv: s.naziv, jed_mjera: s.jed_mjera,
      grupa: s.grupa, debljina_cm: s.debljina_cm,
      slika: s.slika, slika_puna: s.slika_puna,
      dostupno: parseFloat(s.stanje) > 0,
      cijena: c.konacna, cijena_bez_pdv: c.bez_pdv, pdv_iznos: c.pdv_iznos,
    };
  });
  return { stavke, tip_naziv: tip?.naziv || null, pdv_stopa: stopa, sa_pdv: !!tip?.dodaje_pdv };
}

module.exports = router;
module.exports.ucitajStavke = ucitajStavke;
