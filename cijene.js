// routes/cijene.js
// ══ CIJENE PO TIPU KUPCA ══════════════════════════════════════════════════════════
// Cijena u lageru (roba_pj.cijena) je JEDINSTVENA OSNOVICA, uvijek BEZ PDV-a.
// Iz nje se izvodi cijena za konkretnog kupca:
//   1. popust tipa kupca      (npr. kamenoresci −12%)
//   2. + popust na kolicinu   (npr. preko 50 m² dodatnih −3%)
//   3. + PDV, ali SAMO ako tip kupca to trazi (krajnji kupac)
//
// Sve na JEDNOM mjestu — da se ista formula ne prepisuje po modulima i razidje.
const express = require('express');
const router = express.Router();
const pool = require('./db');

function samoAdmin(req, res, next) {
  if (req.session?.user?.rola === 'admin') return next();
  return res.status(403).json({ error: 'Samo admin može mijenjati pravila cijena.' });
}

// Ucitava PDV stopu iz postavki (podesiva, ne zakucana u kod).
async function pdvStopa() {
  const r = await pool.query(`SELECT vrijednost FROM lager_postavke WHERE kljuc='pdv_stopa'`);
  return r.rows.length ? parseFloat(r.rows[0].vrijednost) : 17;
}

/**
 * Racuna konacnu cijenu za jedan artikal.
 * @param {number} osnovica   cijena iz lagera (bez PDV-a)
 * @param {object} tip        red iz tipovi_kupaca (ili null = osnovica bez izmjena)
 * @param {number} kolicina   za popust na kolicinu
 * @param {array}  popusti    redovi iz kolicinski_popusti koji vaze za taj tip
 * @param {number} pdv        stopa PDV-a u procentima
 */
function izracunajCijenu(osnovica, tip, kolicina, popusti, pdv) {
  const baza = parseFloat(osnovica) || 0;
  if (!tip) return { osnovica: baza, popust_tip: 0, popust_kolicina: 0, bez_pdv: baza, pdv_iznos: 0, konacna: baza };

  const popustTip = parseFloat(tip.popust_posto) || 0;
  // Popust na kolicinu — uzima se NAJVECI prag koji je dostignut (ne zbrajaju se svi).
  const primjenjiv = (popusti || [])
    .filter(p => parseFloat(kolicina) >= parseFloat(p.od_kolicine))
    .sort((a, b) => parseFloat(b.od_kolicine) - parseFloat(a.od_kolicine))[0];
  const popustKolicina = primjenjiv ? parseFloat(primjenjiv.dodatni_popust) : 0;

  // Popusti se sabiraju pa primjenjuju jednom (jasnije kupcu nego lančano računanje).
  const ukupanPopust = popustTip + popustKolicina;
  const bezPdv = +(baza * (1 - ukupanPopust / 100)).toFixed(2);
  const pdvIznos = tip.dodaje_pdv ? +(bezPdv * pdv / 100).toFixed(2) : 0;

  return {
    osnovica: baza,
    popust_tip: popustTip,
    popust_kolicina: popustKolicina,
    bez_pdv: bezPdv,
    pdv_iznos: pdvIznos,
    konacna: +(bezPdv + pdvIznos).toFixed(2),
  };
}

// ── TIPOVI KUPACA ───────────────────────────────────────────────────────────────────

// GET /api/cijene/tipovi — spisak tipova (svi prijavljeni, treba im za katalog)
router.get('/tipovi', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const r = await pool.query(
      `SELECT t.*, (SELECT COUNT(*) FROM kupci k WHERE k.tip_id=t.id) AS broj_kupaca
       FROM tipovi_kupaca t WHERE t.aktivan=true ORDER BY t.redosled, t.naziv`
    );
    res.json({ tipovi: r.rows, pdv_stopa: await pdvStopa() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cijene/tipovi — novi tip
router.post('/tipovi', samoAdmin, async (req, res) => {
  const { naziv, popust_posto, dodaje_pdv, napomena } = req.body || {};
  if (!naziv || !naziv.trim()) return res.status(400).json({ error: 'Naziv je obavezan.' });
  try {
    const r = await pool.query(
      `INSERT INTO tipovi_kupaca (naziv, popust_posto, dodaje_pdv, napomena, redosled)
       VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(redosled),0)+1 FROM tipovi_kupaca))
       RETURNING *`,
      [naziv.trim(), parseFloat(popust_posto) || 0, dodaje_pdv === true, napomena || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Tip sa tim nazivom već postoji.' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/cijene/tipovi/:id — izmjena (najčešće samo popust)
router.patch('/tipovi/:id', samoAdmin, async (req, res) => {
  const dozvoljena = ['naziv', 'popust_posto', 'dodaje_pdv', 'napomena', 'aktivan', 'redosled'];
  const polja = Object.keys(req.body || {}).filter(k => dozvoljena.includes(k));
  if (!polja.length) return res.status(400).json({ error: 'Nema polja za izmjenu.' });
  try {
    const set = polja.map((k, i) => `${k}=$${i + 2}`).join(', ');
    const r = await pool.query(
      `UPDATE tipovi_kupaca SET ${set} WHERE id=$1 RETURNING *`,
      [req.params.id, ...polja.map(k => req.body[k])]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Tip nije pronađen.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/cijene/pdv — promjena stope PDV-a
router.patch('/pdv', samoAdmin, async (req, res) => {
  const stopa = parseFloat(req.body?.stopa);
  if (isNaN(stopa) || stopa < 0 || stopa > 100) return res.status(400).json({ error: 'Neispravna stopa.' });
  try {
    await pool.query(
      `INSERT INTO lager_postavke (kljuc, vrijednost) VALUES ('pdv_stopa',$1)
       ON CONFLICT (kljuc) DO UPDATE SET vrijednost=$1`, [stopa]
    );
    res.json({ ok: true, stopa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POPUSTI NA KOLICINU ─────────────────────────────────────────────────────────────

router.get('/kolicinski-popusti', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const r = await pool.query(
      `SELECT kp.*, t.naziv AS tip_naziv FROM kolicinski_popusti kp
       LEFT JOIN tipovi_kupaca t ON t.id = kp.tip_kupca_id
       ORDER BY kp.tip_kupca_id NULLS FIRST, kp.od_kolicine`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/kolicinski-popusti', samoAdmin, async (req, res) => {
  const { tip_kupca_id, od_kolicine, dodatni_popust, napomena } = req.body || {};
  if (!od_kolicine || !dodatni_popust) return res.status(400).json({ error: 'Količina i popust su obavezni.' });
  try {
    const r = await pool.query(
      `INSERT INTO kolicinski_popusti (tip_kupca_id, od_kolicine, dodatni_popust, napomena)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tip_kupca_id || null, parseFloat(od_kolicine), parseFloat(dodatni_popust), napomena || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/kolicinski-popusti/:id', samoAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM kolicinski_popusti WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PRERAČUN ────────────────────────────────────────────────────────────────────────

// GET /api/cijene/preracun?tip_id=X&osnovica=Y&kolicina=Z — provjera "koliko bi bilo"
router.get('/preracun', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const tipId = req.query.tip_id ? parseInt(req.query.tip_id) : null;
    const osnovica = parseFloat(req.query.osnovica) || 0;
    const kolicina = parseFloat(req.query.kolicina) || 0;
    let tip = null;
    if (tipId) {
      const t = await pool.query('SELECT * FROM tipovi_kupaca WHERE id=$1', [tipId]);
      tip = t.rows[0] || null;
    }
    const p = await pool.query(
      'SELECT * FROM kolicinski_popusti WHERE tip_kupca_id IS NULL OR tip_kupca_id=$1', [tipId]
    );
    res.json(izracunajCijenu(osnovica, tip, kolicina, p.rows, await pdvStopa()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.izracunajCijenu = izracunajCijenu;
module.exports.pdvStopa = pdvStopa;
