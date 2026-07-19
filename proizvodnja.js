// routes/proizvodnja.js DODAJ NA RAIL
const express = require('express');
const router = express.Router();
const pool = require('./db');

// Finansijske kolone - vide ih samo admini
const ADMIN_COLS = `
  p.ugovorena_suma, p.avans, p.avans_opis,
  (COALESCE(p.ugovorena_suma,0) - COALESCE(p.avans,0)) AS za_naplatu,
  p.naplata_detalji, p.naplaceno_fakturisano, p.dodatni_rad_napomena,
  ga.predano AS avans_predano, gn.predano AS naplata_predano
`;

// JOIN koji provjerava da li je gotovina za avans/naplatu ovog naloga I OVDE
// već predata blagajniku (sve odgovarajuće stavke moraju biti predane)
const GOTOVINA_JOINS = `
  LEFT JOIN LATERAL (
    SELECT bool_and(predao_blagajniku) AS predano
    FROM gotovina g WHERE g.nalog_r_br = p.r_br::text AND g.opis LIKE 'Avans%'
  ) ga ON true
  LEFT JOIN LATERAL (
    SELECT bool_and(predao_blagajniku) AS predano
    FROM gotovina g WHERE g.nalog_r_br = p.r_br::text AND g.opis LIKE 'Naplata%'
  ) gn ON true
`;

// Tehničke kolone - vide ih svi
const BASE_COLS = `
  p.r_br, p.zadatak, p.prioritet, p.ugovorio_id, p.ugovorio,
  p.narucilac, p.materijal, p.status, p.pocetak, p.planirani_zavrsetak,
  (p.planirani_zavrsetak - CURRENT_DATE) AS broj_dana,
  p.gotovo, p.reklamacija_dodatni_rad, p.napomena,
  p.link_skica, p.link_ponuda, p.datum_kreiranja, p.nova_procjena,
  p.naplaceno, p.naplaceno_opis
`;

// GET /api/proizvodnja - lista (admin vidi finansije, ostali ne)
router.get('/', async (req, res) => {
  const isAdmin = req.session?.user?.rola === 'admin';
  const cols = isAdmin ? BASE_COLS + ',' + ADMIN_COLS : BASE_COLS;
  const joins = isAdmin ? GOTOVINA_JOINS : '';
  try {
    const r = await pool.query(
      `SELECT ${cols} FROM proizvodnja_jopex p ${joins} ORDER BY p.r_br DESC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri učitavanju naloga.' });
  }
});

// GET /api/proizvodnja/:r_br - jedan nalog
router.get('/:r_br', async (req, res) => {
  const isAdmin = req.session?.user?.rola === 'admin';
  const cols = isAdmin ? BASE_COLS + ',' + ADMIN_COLS : BASE_COLS;
  const joins = isAdmin ? GOTOVINA_JOINS : '';
  try {
    const r = await pool.query(
      `SELECT ${cols} FROM proizvodnja_jopex p ${joins} WHERE p.r_br = $1`,
      [req.params.r_br]
    );
    if (!r.rows.length)
      return res.status(404).json({ error: 'Nalog nije pronađen.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Greška.' });
  }
});

// POST /api/proizvodnja - novi nalog
// Poziva se i iz web forme i iz JoPeX HTML (usvajanje ponude)
router.post('/', async (req, res) => {
  const {
    zadatak, prioritet, ugovorio_id, ugovorio: ugovorioIzReq, narucilac, materijal, status,
    pocetak, planirani_zavrsetak, napomena, link_skica, link_ponuda,
    ugovorena_suma, avans, gotovo, reklamacija_dodatni_rad, r_br_import,
  } = req.body || {};

  if (!zadatak?.trim())
    return res.status(400).json({ error: '"zadatak" je obavezno polje.' });

  try {
    let ugovorioIme = ugovorioIzReq || null;
    if (ugovorio_id) {
      const emp = await pool.query(
        `SELECT ime_prezime FROM zaposleni
         WHERE id = $1 AND aktivan = true`,
        [ugovorio_id]
      );
      if (emp.rows.length) ugovorioIme = emp.rows[0].ime_prezime;
    }

    // Ako je import sa originalnim R.Br., upiši ga direktno
    let insertQuery, insertVals;
    if (r_br_import) {
      insertQuery = `INSERT INTO proizvodnja_jopex
        (r_br, zadatak, prioritet, ugovorio_id, ugovorio, narucilac, materijal,
         status, pocetak, planirani_zavrsetak, napomena, link_skica,
         link_ponuda, ugovorena_suma, avans, gotovo, reklamacija_dodatni_rad)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (r_br) DO NOTHING
       RETURNING r_br, zadatak, narucilac, ugovorena_suma, status`;
      insertVals = [
        r_br_import,
        zadatak, prioritet || 'Normal',
        ugovorio_id || null, ugovorioIme,
        narucilac || null, materijal || null,
        status || 'Nije Započeto',
        pocetak || null, planirani_zavrsetak || null,
        napomena || null, link_skica || null, link_ponuda || null,
        ugovorena_suma ?? 0, avans ?? 0,
        gotovo || false, reklamacija_dodatni_rad || null,
      ];
    } else {
      insertQuery = `INSERT INTO proizvodnja_jopex
        (zadatak, prioritet, ugovorio_id, ugovorio, narucilac, materijal,
         status, pocetak, planirani_zavrsetak, napomena, link_skica,
         link_ponuda, ugovorena_suma, avans, gotovo, reklamacija_dodatni_rad)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING r_br, zadatak, narucilac, ugovorena_suma, status`;
      insertVals = [
        zadatak, prioritet || 'Normal',
        ugovorio_id || null, ugovorioIme,
        narucilac || null, materijal || null,
        status || 'Nije Započeto',
        pocetak || new Date().toISOString().split('T')[0], planirani_zavrsetak || null,
        napomena || null, link_skica || null, link_ponuda || null,
        ugovorena_suma ?? 0, avans ?? 0,
        gotovo || false, reklamacija_dodatni_rad || null,
      ];
    }
    const r = await pool.query(insertQuery, insertVals);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri upisu: ' + err.message });
  }
});

// Pomoćne funkcije za prepoznavanje gotovinskog opisa ("got Boban 15/7"...)
function jeGotovina(val) {
  return /^got\b/i.test(String(val || '').trim());
}
function izvuciPrimio(val) {
  const m = /^got\s+(\S+)/i.exec(String(val || '').trim());
  return m ? m[1] : 'Nepoznato';
}

// PATCH /api/proizvodnja/:r_br - djelimično ažuriranje
router.patch('/:r_br', async (req, res) => {
  const isAdmin = req.session?.user?.rola === 'admin';

  const ALLOWED_BASE = [
    'zadatak','prioritet','narucilac','materijal','status','pocetak',
    'planirani_zavrsetak','gotovo','reklamacija_dodatni_rad','napomena',
    'link_skica','link_ponuda','nova_procjena',
  ];
  const ALLOWED_ADMIN = [
    'ugovorena_suma','avans','avans_opis','naplata_detalji',
    'naplaceno_fakturisano','dodatni_rad_napomena','naplaceno','naplaceno_opis',
  ];

  const allowed = isAdmin ? [...ALLOWED_BASE, ...ALLOWED_ADMIN] : ALLOWED_BASE;
  const sets = [], vals = [];
  let i = 1;

  for (const key of allowed) {
    if (key in req.body) { sets.push(`${key} = $${i++}`); vals.push(req.body[key]); }
  }

  // Poseban slučaj: ugovorio_id (treba validaciju + upisati i ugovorio tekst)
  if (req.body.ugovorio_id !== undefined) {
    let ugovorioIme = null;
    if (req.body.ugovorio_id) {
      const emp = await pool.query(
        `SELECT ime_prezime FROM zaposleni WHERE id=$1 AND moze_ugovarati=true AND aktivan=true`,
        [req.body.ugovorio_id]
      );
      if (!emp.rows.length)
        return res.status(400).json({ error: 'Osoba ne može biti "Ugovorio".' });
      ugovorioIme = emp.rows[0].ime_prezime;
    }
    sets.push(`ugovorio_id = $${i++}`); vals.push(req.body.ugovorio_id || null);
    sets.push(`ugovorio = $${i++}`);    vals.push(ugovorioIme);
  }

  if (!sets.length)
    return res.status(400).json({ error: 'Nema polja za izmjenu.' });

  // Ako mijenjamo avans_opis ili naplaceno_opis, treba nam stanje PRIJE izmjene
  // da bismo upis u blagajnu napravili samo jednom (kad se vrijednost stvarno promijeni)
  const trebaProvjeruGotovine = isAdmin && ('avans_opis' in req.body || 'naplaceno_opis' in req.body);
  let staro = null;
  if (trebaProvjeruGotovine) {
    const s = await pool.query(
      `SELECT avans_opis, naplaceno_opis FROM proizvodnja_jopex WHERE r_br = $1`,
      [req.params.r_br]
    );
    staro = s.rows[0] || {};
  }

  vals.push(req.params.r_br);
  try {
    const r = await pool.query(
      `UPDATE proizvodnja_jopex SET ${sets.join(', ')} WHERE r_br = $${i}
       RETURNING r_br, status, avans_opis, naplaceno_opis, avans, ugovorena_suma, narucilac`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    const novo = r.rows[0];

    if (trebaProvjeruGotovine) {
      // AVANS -> ako je postavljen na gotovinu, promijenjen je, I iznos je > 0
      const avansIznos = Number(novo.avans || 0);
      if ('avans_opis' in req.body &&
          novo.avans_opis !== staro.avans_opis &&
          jeGotovina(novo.avans_opis) &&
          avansIznos > 0) {
        await pool.query(
          `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis)
           VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4)`,
          [
            avansIznos,
            izvuciPrimio(novo.avans_opis),
            novo.r_br,
            `Avans - nalog #${novo.r_br}${novo.narucilac ? ' (' + novo.narucilac + ')' : ''}`,
          ]
        );
      }

      // NAPLATA (preostali iznos) -> isto, ako je gotovina, promijenjena, I iznos je > 0
      const zaNaplatu = Number(novo.ugovorena_suma || 0) - Number(novo.avans || 0);
      if ('naplaceno_opis' in req.body &&
          novo.naplaceno_opis !== staro.naplaceno_opis &&
          jeGotovina(novo.naplaceno_opis) &&
          zaNaplatu > 0) {
        await pool.query(
          `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis)
           VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4)`,
          [
            zaNaplatu,
            izvuciPrimio(novo.naplaceno_opis),
            novo.r_br,
            `Naplata - nalog #${novo.r_br}${novo.narucilac ? ' (' + novo.narucilac + ')' : ''}`,
          ]
        );
      }
    }

    res.json(novo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri ažuriranju: ' + err.message });
  }
});

// DELETE /api/proizvodnja/:r_br - brisanje naloga (samo admin)
router.delete('/:r_br', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const r = await pool.query(
      'DELETE FROM proizvodnja_jopex WHERE r_br=$1 RETURNING r_br',
      [req.params.r_br]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađen.' });
    // Reset sequence na MAX r_br
    await pool.query(
      `SELECT setval('proizvodnja_jopex_r_br_seq', COALESCE((SELECT MAX(r_br) FROM proizvodnja_jopex), 0), true)`
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

module.exports = router;
