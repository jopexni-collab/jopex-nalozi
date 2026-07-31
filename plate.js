// plate.js — mesečno praćenje plata (admin-only)
const express = require('express');
const router = express.Router();
const pool = require('./db');

router.use((req, res, next) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin ima pristup ovom modulu.' });
  next();
});

// GET /api/plate?mesec=2026-07 — sve stavke za taj mjesec (mesec = YYYY-MM)
router.get('/', async (req, res) => {
  try {
    const { mesec } = req.query;
    if (!mesec) return res.status(400).json({ error: 'Nedostaje mesec (YYYY-MM).' });
    const r = await pool.query(
      `SELECT p.*, z.ime_prezime AS zaposleni_ime
       FROM plate p LEFT JOIN zaposleni z ON z.id = p.zaposleni_id
       WHERE to_char(p.mesec, 'YYYY-MM') = $1
       ORDER BY COALESCE(z.ime_prezime, p.ime_slobodno)`,
      [mesec]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/plate — kreira ili ažurira jedan red (ukupno se NE ČUVA direktno — uvijek se
// računa iz gotovina+račun, na frontu i po potrebi ovdje, da nikad ne mogu da se raziđu).
router.post('/', async (req, res) => {
  const user = req.session.user;
  const {
    id, zaposleni_id, ime_slobodno, mesec,
    iznos_gotovina_eur, iznos_gotovina_km, iznos_racun_km,
    bonus_km, bonus_razlog, kazna_km, kazna_razlog,
    tag_planiranje, tag_razlog, napomena,
  } = req.body || {};
  if (!mesec) return res.status(400).json({ error: 'Mesec je obavezan.' });
  if (!zaposleni_id && !ime_slobodno?.trim())
    return res.status(400).json({ error: 'Zaposleni ili ime su obavezni.' });
  try {
    let r;
    if (id) {
      r = await pool.query(
        `UPDATE plate SET
           zaposleni_id=$1, ime_slobodno=$2, iznos_gotovina_eur=$3, iznos_gotovina_km=$4,
           iznos_racun_km=$5, bonus_km=$6, bonus_razlog=$7, kazna_km=$8, kazna_razlog=$9,
           tag_planiranje=$10, tag_razlog=$11, napomena=$12, azurirano=now()
         WHERE id=$13 RETURNING *`,
        [zaposleni_id || null, ime_slobodno || null, iznos_gotovina_eur || 0, iznos_gotovina_km || 0,
         iznos_racun_km || 0, bonus_km || 0, bonus_razlog || null, kazna_km || 0, kazna_razlog || null,
         tag_planiranje || null, tag_razlog || null, napomena || null, id]
      );
    } else {
      r = await pool.query(
        `INSERT INTO plate
           (zaposleni_id, ime_slobodno, mesec, iznos_gotovina_eur, iznos_gotovina_km,
            iznos_racun_km, bonus_km, bonus_razlog, kazna_km, kazna_razlog,
            tag_planiranje, tag_razlog, napomena, upisao_id, upisao_ime)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [zaposleni_id || null, ime_slobodno || null, mesec + '-01', iznos_gotovina_eur || 0,
         iznos_gotovina_km || 0, iznos_racun_km || 0, bonus_km || 0, bonus_razlog || null,
         kazna_km || 0, kazna_razlog || null, tag_planiranje || null, tag_razlog || null,
         napomena || null, user.id, user.ime_prezime]
      );
    }
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/plate/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM plate WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/plate/kopiraj-sledeci-mjesec — PLANIRANJE: kopira sve redove iz mjeseca X u
// mjesec X+1 kao polaznu tačku (isti gotovina/račun iznosi, isti tagovi vidljivi da se
// ne zaboravi ko je bio označen za povećanje/smanjenje), BEZ bonusa/kazni (to je uvijek
// specifično za taj mjesec, ne prenosi se automatski). Ne diraj ako ciljni mjesec već
// ima redove — sigurnosna provjera da se slučajno ne prepiše nešto već uneseno.
router.post('/kopiraj-sledeci-mjesec', async (req, res) => {
  const user = req.session.user;
  const { iz_mjeseca, u_mjesec } = req.body || {};
  if (!iz_mjeseca || !u_mjesec) return res.status(400).json({ error: 'Nedostaju mjeseci.' });
  try {
    const postoje = await pool.query(
      `SELECT COUNT(*) FROM plate WHERE to_char(mesec,'YYYY-MM')=$1`, [u_mjesec]
    );
    if (+postoje.rows[0].count > 0)
      return res.status(400).json({ error: `Mjesec ${u_mjesec} već ima unesene redove — obriši ih prvo ako želiš da ponovo kopiraš, ili ih uredi ručno.` });

    const stari = await pool.query(
      `SELECT * FROM plate WHERE to_char(mesec,'YYYY-MM')=$1`, [iz_mjeseca]
    );
    if (!stari.rows.length) return res.status(400).json({ error: `Nema redova u ${iz_mjeseca} za kopiranje.` });

    const novi = [];
    for (const red of stari.rows) {
      const r = await pool.query(
        `INSERT INTO plate
           (zaposleni_id, ime_slobodno, mesec, iznos_gotovina_eur, iznos_gotovina_km,
            iznos_racun_km, tag_planiranje, tag_razlog, napomena, upisao_id, upisao_ime)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [red.zaposleni_id, red.ime_slobodno, u_mjesec + '-01', red.iznos_gotovina_eur,
         red.iznos_gotovina_km, red.iznos_racun_km, red.tag_planiranje, red.tag_razlog,
         'Kopirano iz ' + iz_mjeseca + ' (planiranje)', user.id, user.ime_prezime]
      );
      novi.push(r.rows[0]);
    }
    res.json({ ok: true, kopirano: novi.length, redovi: novi });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/plate/statistika — agregat po zaposlenom kroz vrijeme, i ukupno po mjesecu.
router.get('/statistika', async (req, res) => {
  try {
    const poZaposlenom = await pool.query(`
      SELECT COALESCE(z.ime_prezime, p.ime_slobodno) AS ime,
             COUNT(*) AS broj_mjeseci,
             SUM(p.iznos_gotovina_km + p.iznos_racun_km) AS ukupno_bruto,
             SUM(p.bonus_km) AS ukupno_bonus,
             SUM(p.kazna_km) AS ukupno_kazna,
             SUM(p.iznos_gotovina_km + p.iznos_racun_km - p.kazna_km) AS ukupno_isplaceno
      FROM plate p LEFT JOIN zaposleni z ON z.id = p.zaposleni_id
      GROUP BY COALESCE(z.ime_prezime, p.ime_slobodno)
      ORDER BY ukupno_isplaceno DESC
    `);
    const poMjesecu = await pool.query(`
      SELECT to_char(mesec,'YYYY-MM') AS mesec,
             SUM(iznos_gotovina_km + iznos_racun_km) AS ukupno_bruto,
             SUM(bonus_km) AS ukupno_bonus,
             SUM(kazna_km) AS ukupno_kazna,
             SUM(iznos_gotovina_km + iznos_racun_km - kazna_km) AS ukupno_isplaceno,
             SUM(iznos_racun_km) AS ukupno_racun,
             SUM(iznos_gotovina_km) AS ukupno_gotovina,
             COUNT(*) AS broj_zaposlenih
      FROM plate GROUP BY mesec ORDER BY mesec DESC
    `);
    res.json({ po_zaposlenom: poZaposlenom.rows, po_mjesecu: poMjesecu.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
