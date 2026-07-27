// finansije.js — dva nova pod-modula unutar blagajne: Banka i Klijenti finansije
const express = require('express');
const router = express.Router();
const pool = require('./db');

const BANKE = ['rfb', 'uni', 'mf', 'nlb', 'uni1'];

function jeDozvoljeno(user) {
  return !!user && (user.rola === 'admin' || user.je_blagajnik || user.moze_prodavati);
}

/* ═══ BANKA ═══════════════════════════════════════════════════════════════ */

// GET /api/finansije/banka — lista bankovnih uplata, sa filterima (banka, od, do,
// neraspoređeno). Bez filtera vraća sve (limit 300, najnovije prvo).
router.get('/banka', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const { banka, od, do: do_, nerasporedjeno } = req.query;
    const where = [];
    const vals = [];
    let i = 1;
    if (nerasporedjeno === 'true') where.push('banka IS NULL');
    else if (banka) { where.push(`banka = $${i++}`); vals.push(banka); }
    if (od) { where.push(`datum >= $${i++}`); vals.push(od); }
    if (do_) { where.push(`datum <= $${i++}`); vals.push(do_); }
    const r = await pool.query(
      `SELECT * FROM banka_uplate ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY datum DESC LIMIT 300`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/finansije/banka/stanje — zbir po svakoj od 5 banaka + neraspoređeno, za brz
// pregled ("koliko je trenutno u kojoj banci upisano preko sistema").
router.get('/banka/stanje', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const r = await pool.query(
      `SELECT COALESCE(banka,'nerasporedjeno') AS banka, COALESCE(SUM(iznos),0) AS zbir, COUNT(*) AS broj
       FROM banka_uplate GROUP BY banka`
    );
    const mapa = {};
    BANKE.forEach(b => mapa[b] = { banka: b, zbir: 0, broj: 0 });
    mapa.nerasporedjeno = { banka: 'nerasporedjeno', zbir: 0, broj: 0 };
    r.rows.forEach(row => { mapa[row.banka] = { banka: row.banka, zbir: +row.zbir, broj: +row.broj }; });
    res.json(Object.values(mapa));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/finansije/banka/:id — dodjela neraspoređenog zapisa konkretnoj banci
// (ili promjena banke ako je ranije pogrešno dodijeljena).
router.patch('/banka/:id', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  const { banka } = req.body;
  if (!BANKE.includes(banka)) return res.status(400).json({ error: 'Nepoznata banka.' });
  try {
    const r = await pool.query('UPDATE banka_uplate SET banka=$1 WHERE id=$2 RETURNING *', [banka, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ═══ KLIJENTI FINANSIJE ═════════════════════════════════════════════════ */

// GET /api/finansije/klijenti — po klijentu: koliko duguje (razdvojeno po očekivanom
// načinu naplate — banka/gotovina/nepoznato), plus koliko je DO SAD stvarno uplatio u
// svaku kategoriju. Radi i za registrovane (kupac_id) i za slobodno upisane (samo ime) —
// slobodno upisani se GRUPIŠU po tačnom nazivu (manje pouzdano — otud upozorenje na
// frontend-u da ih treba registrovati).
router.get('/klijenti', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    // Dug iz maloprodaje (otpremnice), grupisan po klijentu i po OČEKIVANOM načinu naplate.
    const dugMalo = await pool.query(`
      SELECT
        COALESCE(kupac_id::text, 'ime:'||LOWER(TRIM(kupac_naziv))) AS kljuc,
        kupac_id, kupac_naziv,
        COALESCE(ocekivani_nacin_naplate, 'nepoznato') AS nacin,
        SUM(ukupan_iznos - iznos_placeno) AS iznos
      FROM otpremnice
      WHERE status_placanja != 'placeno' AND status = 'potvrdjena' AND kupac_naziv IS NOT NULL
      GROUP BY kljuc, kupac_id, kupac_naziv, COALESCE(ocekivani_nacin_naplate, 'nepoznato')
    `);

    // Dug iz radnih naloga (proizvodnja_jopex) — nema podjelu banka/gotovina (bira se tek
    // pri stvarnoj naplati), pa ide u "nepoznato" kategoriju, po naručiocu (slobodan tekst).
    const dugNalozi = await pool.query(`
      SELECT
        'ime:'||LOWER(TRIM(narucilac)) AS kljuc,
        NULL::int AS kupac_id, narucilac AS kupac_naziv,
        'nepoznato' AS nacin,
        SUM(ugovorena_suma - avans - naplaceno_iznos) AS iznos
      FROM proizvodnja_jopex
      WHERE COALESCE(stornirano,false)=false
        AND narucilac IS NOT NULL AND TRIM(narucilac) != ''
        AND (ugovorena_suma - avans - naplaceno_iznos) > 0.01
      GROUP BY kljuc, narucilac
    `);

    // Stvarno uplaćeno u banku (istorijski) — po klijentu, iz banka_uplate.
    const uplatioBanka = await pool.query(`
      SELECT
        COALESCE(kupac_id::text, 'ime:'||LOWER(TRIM(kupac_naziv))) AS kljuc,
        kupac_id, kupac_naziv, SUM(iznos) AS iznos
      FROM banka_uplate
      WHERE kupac_naziv IS NOT NULL
      GROUP BY kljuc, kupac_id, kupac_naziv
    `);

    // Sastavi jedinstvenu mapu po klijentu.
    const klijenti = {};
    function osiguraj(kljuc, kupacId, naziv) {
      if (!klijenti[kljuc]) {
        klijenti[kljuc] = {
          kupac_id: kupacId || null, kupac_naziv: naziv,
          registrovan: !!kupacId,
          duguje_banka: 0, duguje_gotovina: 0, duguje_nepoznato: 0,
          uplaceno_banka_istorijski: 0,
        };
      }
      return klijenti[kljuc];
    }
    for (const row of dugMalo.rows) {
      const k = osiguraj(row.kljuc, row.kupac_id, row.kupac_naziv);
      if (row.nacin === 'banka') k.duguje_banka += +row.iznos;
      else if (row.nacin === 'gotovina') k.duguje_gotovina += +row.iznos;
      else k.duguje_nepoznato += +row.iznos;
    }
    for (const row of dugNalozi.rows) {
      const k = osiguraj(row.kljuc, row.kupac_id, row.kupac_naziv);
      k.duguje_nepoznato += +row.iznos;
    }
    for (const row of uplatioBanka.rows) {
      const k = osiguraj(row.kljuc, row.kupac_id, row.kupac_naziv);
      k.uplaceno_banka_istorijski += +row.iznos;
    }

    const lista = Object.values(klijenti)
      .map(k => ({
        ...k,
        duguje_ukupno: +(k.duguje_banka + k.duguje_gotovina + k.duguje_nepoznato).toFixed(2),
        duguje_banka: +k.duguje_banka.toFixed(2),
        duguje_gotovina: +k.duguje_gotovina.toFixed(2),
        duguje_nepoznato: +k.duguje_nepoznato.toFixed(2),
        uplaceno_banka_istorijski: +k.uplaceno_banka_istorijski.toFixed(2),
      }))
      .filter(k => k.duguje_ukupno > 0.01 || k.uplaceno_banka_istorijski > 0.01)
      .sort((a, b) => b.duguje_ukupno - a.duguje_ukupno);

    res.json(lista);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
