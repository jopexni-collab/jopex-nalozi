// nalog-stavke.js — POZICIJE RADNOG NALOGA
//
// Radni nalog do sada opisuje posao recenicom ("Rosa porino 2 cm gazista flamed...").
// Iz toga se ne moze traziti restl ni planirati rez. Ovaj modul daje nalogu STRUKTURU:
// jedan red = jedna pozicija koja se reze.
//
// Mjere su u MILIMETRIMA — isto kao u modulu restlova (restlovi.dim_a/dim_b), da se
// nigdje ne mora pretvarati.

const express = require('express');
const router = express.Router();
const pool = require('./db');

/* Citanje brojeva sa ZAREZOM kao decimalom — isto pravilo kao u pregledacu.
   parseFloat("1.234,56") vraca 1.234 (hiljadu puta manje), a "17,55" vraca 17. */
function broj(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(/,/g, '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function smijeMijenjati(req) {
  const u = req.session?.user;
  return u?.rola === 'admin' || u?.unos_naloga || u?.izmjena_naloga
      || u?.moze_ugovarati || u?.moze_roba_magacin;
}

/* ── GET /api/nalog-stavke/:r_br — pozicije jednog naloga ────────────────────────
   Uz svaku poziciju vraca i dimenzije table iz lagera (std_sirina/std_visina) —
   frontend na osnovu njih zna da li moze planirati rez ili prvo mora traziti unos. */
router.get('/:r_br', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const r = await pool.query(
      `SELECT ns.*,
              ro.sifra        AS roba_sifra,
              ro.naziv        AS roba_naziv,
              ro.std_sirina, ro.std_visina,
              ro.debljina_cm  AS roba_debljina
       FROM nalog_stavke ns
       LEFT JOIN roba ro ON ro.id = ns.roba_id
       WHERE ns.nalog_r_br = $1
       ORDER BY ns.redni_broj, ns.id`,
      [req.params.r_br]
    );
    res.json(r.rows.map(x => ({
      ...x,
      sirina: +broj(x.sirina).toFixed(1),
      visina: +broj(x.visina).toFixed(1),
      povrsina_m2: +((broj(x.sirina) * broj(x.visina) * (x.kolicina || 1)) / 1000000).toFixed(3),
      // Rez se moze planirati SAMO ako se zna mjera table
      moze_planirati: x.std_sirina != null && x.std_visina != null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/nalog-stavke/:r_br — dodaj poziciju ─────────────────────────────── */
router.post('/:r_br', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });

  const { naziv, roba_id, materijal, debljina_cm, oblik, poligon,
          obrada_ivica, napomena } = req.body || {};
  const sirina = broj(req.body?.sirina);
  const visina = broj(req.body?.visina);
  const kolicina = parseInt(req.body?.kolicina) || 1;

  if (sirina <= 0 || visina <= 0)
    return res.status(400).json({ error: 'Unesite širinu i visinu (mm).' });
  // Mjere su u MILIMETRIMA — stiti od unosa u centimetrima (120 umjesto 1200)
  if (sirina < 20 || visina < 20)
    return res.status(400).json({
      error: `Mjere se unose u MILIMETRIMA (npr. 1200 × 600). Uneseno: ${sirina} × ${visina}.`,
    });
  if (kolicina < 1)
    return res.status(400).json({ error: 'Količina mora biti bar 1.' });

  try {
    const sljedeci = await pool.query(
      'SELECT COALESCE(MAX(redni_broj),0)+1 AS n FROM nalog_stavke WHERE nalog_r_br=$1',
      [req.params.r_br]
    );
    const r = await pool.query(
      `INSERT INTO nalog_stavke
         (nalog_r_br, redni_broj, naziv, roba_id, materijal, debljina_cm,
          sirina, visina, kolicina, oblik, poligon, obrada_ivica, napomena, izvor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'rucno') RETURNING *`,
      [req.params.r_br, sljedeci.rows[0].n, naziv || null, roba_id || null,
       materijal || null, debljina_cm ? broj(debljina_cm) : null,
       sirina, visina, kolicina, oblik || 'pravougaonik',
       poligon ? JSON.stringify(poligon) : null, obrada_ivica || null, napomena || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── PATCH /api/nalog-stavke/stavka/:id — izmjena pozicije ─────────────────────── */
router.patch('/stavka/:id', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });

  const DOZVOLJENA = ['naziv', 'roba_id', 'materijal', 'debljina_cm', 'sirina', 'visina',
                      'kolicina', 'oblik', 'obrada_ivica', 'napomena', 'status', 'redni_broj'];
  const sets = [], vals = [];
  let i = 1;
  for (const k of DOZVOLJENA) {
    if (!(k in req.body)) continue;
    let v = req.body[k];
    if (['sirina', 'visina', 'debljina_cm'].includes(k)) v = broj(v);
    if (['kolicina', 'redni_broj'].includes(k)) v = parseInt(v) || 1;
    sets.push(`${k}=$${i++}`);
    vals.push(v);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nema polja za izmjenu.' });
  vals.push(req.params.id);

  try {
    const r = await pool.query(
      `UPDATE nalog_stavke SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pozicija nije pronađena.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /api/nalog-stavke/stavka/:id ──────────────────────────────────────── */
router.delete('/stavka/:id', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  try {
    const r = await pool.query('DELETE FROM nalog_stavke WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pozicija nije pronađena.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/nalog-stavke/:r_br/iz-ponude — prepis pozicija iz ponude ──────────
   Ponude se ne cuvaju po stavkama u bazi — cijela ponuda je JSON na spoljnom
   skladistu, a u tabeli stoji samo link. Zato frontend procita taj JSON i posalje
   pozicije ovamo. Prepis je JEDNOKRATAN: ako nalog vec ima pozicije, odbija se,
   da se dvostrukim klikom ne udvostruce. */
router.post('/:r_br/iz-ponude', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const stavke = req.body?.stavke;
  if (!Array.isArray(stavke) || !stavke.length)
    return res.status(400).json({ error: 'Ponuda nema pozicija za prepis.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vec = await client.query(
      'SELECT COUNT(*)::int AS n FROM nalog_stavke WHERE nalog_r_br=$1', [req.params.r_br]
    );
    if (vec.rows[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Nalog već ima ${vec.rows[0].n} pozicija — prepis se ne ponavlja. Obriši postojeće ako želiš ponovo.`,
      });
    }

    let upisano = 0, preskoceno = 0;
    for (let i = 0; i < stavke.length; i++) {
      const s = stavke[i];
      /* Ponuda cuva poziciju kao {a, b, kom, nap} — 'a' i 'b' su mjere u MILIMETRIMA
         (npr. a:2000, b:250), isto kao kod nas, pa nema pretvaranja. Prihvataju se i
         drugi nazivi radi sigurnosti ako se struktura negdje razlikuje. */
      const sir = broj(s.a ?? s.sirina ?? s.duzina ?? s.w);
      const vis = broj(s.b ?? s.visina ?? s.sir ?? s.h);
      // Pozicija bez mjere nema svrhu — ne moze se ni traziti restl ni planirati rez
      if (sir <= 0 || vis <= 0) { preskoceno++; continue; }

      await client.query(
        `INSERT INTO nalog_stavke
           (nalog_r_br, redni_broj, naziv, roba_id, materijal, debljina_cm,
            sirina, visina, kolicina, oblik, obrada_ivica, napomena, izvor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ponuda')`,
        [req.params.r_br, i + 1, s.naziv || s.nap || s.opis || null, s.roba_id || null,
         s.materijal || null, s.debljina_cm ? broj(s.debljina_cm) : null,
         sir, vis, parseInt(s.kom ?? s.kolicina) || 1,
         s.oblik || 'pravougaonik', s.obrada_ivica || null, s.napomena || null]
      );
      upisano++;
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, upisano, preskoceno });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
