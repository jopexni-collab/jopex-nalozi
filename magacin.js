// magacin.js — MAGACINSKI DOKUMENTI (spisak i presjek)
//
// Tabelu `magacin_dokumenti` pune svi moduli: restlovi upisuju izdatnice i povratnice,
// maloprodaja otpremnice, nabavka prijemnice. Ovdje je samo ČITANJE i upis onoga što
// nastaje na ovoj strani.
//
// Sadržaj dokumenta stoji u `stavke` (JSONB) — dokument koji je odštampan i potpisan
// mora sutra izgledati isto. Da se sadržaj računa pri svakom otvaranju, storno jedne
// stavke bi tiho promijenio već potpisan papir.

const express = require('express');
const router = express.Router();
const pool = require('./db');

const VRSTE = ['izdatnica','povratnica','prijemnica','otpremnica','kalkulacija','presjek','usaglasavanje','uvoz'];
const SMJEROVI = ['ulaz','izlaz','ispravka'];

router.use((req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  next();
});

/* Odobrava ko radi sa lagerom ili sa kupcima — maloprodaja jer troši isti lager,
   ugovaranje jer odgovara za nalog. Bez nove dozvole. */
function smijeOdobriti(u) {
  return u?.rola === 'admin' || u?.moze_ugovarati === true || u?.moze_prodavati === true;
}

function broj(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

/* ── GET /dokumenti — spisak sa filterima ────────────────────────────────────────── */
router.get('/dokumenti', async (req, res) => {
  const uslovi = [];
  const vals = [];
  let i = 1;

  if (VRSTE.includes(req.query.vrsta)) { uslovi.push(`d.vrsta = $${i++}`); vals.push(req.query.vrsta); }
  if (SMJEROVI.includes(req.query.smjer)) { uslovi.push(`d.smjer = $${i++}`); vals.push(req.query.smjer); }
  if (req.query.objekt_id) { uslovi.push(`d.objekt_id = $${i++}`); vals.push(parseInt(req.query.objekt_id)); }
  if (req.query.izvor_modul) { uslovi.push(`d.izvor_modul = $${i++}`); vals.push(req.query.izvor_modul); }
  if (req.query.nalog) { uslovi.push(`d.nalog_r_br = $${i++}`); vals.push(parseInt(req.query.nalog)); }
  if (req.query.od) { uslovi.push(`d.izdato >= $${i++}::date`); vals.push(req.query.od); }
  if (req.query.do) { uslovi.push(`d.izdato < ($${i++}::date + interval '1 day')`); vals.push(req.query.do); }
  if (req.query.samo_ceka === '1') uslovi.push(`d.odobreno = 'ceka'`);
  if (req.query.samo_otvoreni === '1') uslovi.push(`d.presjek_id IS NULL`);
  if (req.query.q) {
    uslovi.push(`(d.broj ILIKE $${i} OR d.primalac ILIKE $${i} OR d.nalog_r_br::text = $${i + 1})`);
    vals.push(`%${req.query.q}%`, String(req.query.q).trim());
    i += 2;
  }
  /* Stornirani se NE prikazuju podrazumijevano — ostaju u bazi kao trag, ali bi u
     spisku samo smetali. Vide se tek kad se izričito zatraže. */
  if (req.query.sa_storniranim !== '1') uslovi.push(`d.stornirano = false`);

  const gdje = uslovi.length ? `WHERE ${uslovi.join(' AND ')}` : '';
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);

  try {
    const r = await pool.query(
      `SELECT d.*, po.naziv AS objekat_naziv
       FROM magacin_dokumenti d
       LEFT JOIN prodajni_objekti po ON po.id = d.objekt_id
       ${gdje}
       ORDER BY d.izdato DESC NULLS LAST, d.id DESC
       LIMIT ${limit}`,
      vals
    );

    /* Zbirovi se računaju po SMJERU — izlaz i ulaz se ne sabiraju, jer bi zbir bio
       besmislen. Neto je razlika. */
    const izlaz = r.rows.filter(x => x.smjer === 'izlaz');
    const ulaz = r.rows.filter(x => x.smjer === 'ulaz');
    const zbir = a => Math.round(a.reduce((s, x) => s + (Number(x.ukupno_m2) || 0), 0) * 10000) / 10000;

    res.json({
      stavke: r.rows,
      ukupno: r.rows.length,
      izlaz_m2: zbir(izlaz),
      ulaz_m2: zbir(ulaz),
      neto_m2: Math.round((zbir(izlaz) - zbir(ulaz)) * 10000) / 10000,
      ceka_odobrenje: r.rows.filter(x => x.odobreno === 'ceka').length,
      smijem_odobriti: smijeOdobriti(req.session.user),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /dokumenti/broj/:broj — jedan dokument ──────────────────────────────────── */
router.get('/dokumenti/broj/:broj', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.*, po.naziv AS objekat_naziv
       FROM magacin_dokumenti d
       LEFT JOIN prodajni_objekti po ON po.id = d.objekt_id
       WHERE d.broj = $1`, [req.params.broj]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Dokument nije pronađen.' });
    res.json({ ...r.rows[0], smijem_odobriti: smijeOdobriti(req.session.user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /dokumenti — upis dokumenta sa OVE strane ──────────────────────────────────
   Koristi se za otpremnice iz maloprodaje i prijemnice od dobavljača. Izdatnice i
   povratnice upisuje modul restlova sam. */
router.post('/dokumenti', async (req, res) => {
  const u = req.session.user;
  const vrsta = req.body?.vrsta;
  if (!['otpremnica', 'prijemnica'].includes(vrsta))
    return res.status(400).json({ error: 'Ovdje se upisuju samo otpremnice i prijemnice.' });

  const stavke = Array.isArray(req.body?.stavke) ? req.body.stavke : null;
  if (!stavke || !stavke.length)
    return res.status(400).json({ error: 'Dokument bez stavki nema smisla.' });

  const smjer = vrsta === 'otpremnica' ? 'izlaz' : 'ulaz';
  const prefiks = vrsta === 'otpremnica' ? 'OTP' : 'PRI';

  try {
    /* Postojeće otpremnice zadržavaju SVOJ broj — inače bi ista isporuka imala dva
       broja, pa se papir i evidencija ne bi mogli spojiti. */
    let brojDok = String(req.body?.broj || '').trim();
    if (!brojDok) {
      const g = new Date().getFullYear();
      const n = await pool.query(
        `SELECT COUNT(*)::int + 1 AS sl FROM magacin_dokumenti
         WHERE vrsta = $1 AND EXTRACT(YEAR FROM COALESCE(izdato, now())) = $2`,
        [vrsta, g]
      );
      brojDok = `${prefiks}-${g}-${String(n.rows[0].sl).padStart(6, '0')}`;
    }

    const ukupnoM2 = stavke.reduce((s, x) => s + broj(x.povrsina), 0);
    const ukupnoKom = stavke.reduce((s, x) => s + (parseInt(x.komada) || 0), 0);
    const vrijednost = stavke.reduce((s, x) => s + broj(x.vrijednost), 0);

    const r = await pool.query(
      `INSERT INTO magacin_dokumenti
         (broj, vrsta, smjer, objekt_id, izvor_modul, nalog_r_br, otpremnica_id,
          primalac, ukupno_m2, ukupno_kom, vrijednost, stavke,
          izdao_ime, izdato, odobreno)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),'ceka')
       RETURNING *`,
      [brojDok, vrsta, smjer,
       parseInt(req.body?.objekt_id) || null,
       vrsta === 'otpremnica' ? 'maloprodaja' : 'nabavka',
       parseInt(req.body?.nalog_r_br) || null,
       parseInt(req.body?.otpremnica_id) || null,
       req.body?.primalac || null,
       ukupnoM2 || null, ukupnoKom || null, vrijednost || null,
       JSON.stringify(stavke), u.ime_prezime]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Dokument sa tim brojem već postoji.' });
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /dokumenti/zbirno — brojke za zaglavlje taba ────────────────────────────── */
router.get('/dokumenti/zbirno', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE odobreno = 'ceka' AND stornirano = false)::int AS ceka,
         COUNT(*) FILTER (WHERE presjek_id IS NULL AND stornirano = false)::int AS otvoreno,
         COUNT(*) FILTER (WHERE izdato::date = CURRENT_DATE AND stornirano = false)::int AS danas,
         COUNT(*) FILTER (WHERE proknjizeno = false AND odobreno = 'odobreno'
                            AND vrsta IN ('otpremnica','prijemnica') AND stornirano = false)::int AS za_knjizenje
       FROM magacin_dokumenti`
    );
    res.json({ ...r.rows[0], smijem_odobriti: smijeOdobriti(req.session.user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST /dokumenti/:broj/knjizi — oznaka da je dokument prenesen u Bluesoft.
   NE mijenja lager — samo biljezi da je papir otisao u knjigovodstvo, da se dvaput
   ne prenosi. Knjizi ko ima "Ugovara", isto kao sto i odobrava. */
router.post('/dokumenti/:broj/knjizi', async (req, res) => {
  const u = req.session.user;
  if (!(u?.rola === 'admin' || u?.moze_ugovarati === true))
    return res.status(403).json({ error: 'Knjiženje smije potvrditi samo osoba sa pravom „Ugovara".' });

  try {
    const st = await pool.query('SELECT * FROM magacin_dokumenti WHERE broj=$1', [req.params.broj]);
    if (!st.rows.length) return res.status(404).json({ error: 'Dokument nije pronađen.' });
    const d = st.rows[0];

    if (d.stornirano) return res.status(400).json({ error: 'Storniran dokument se ne knjiži.' });
    if (d.proknjizeno)
      return res.status(400).json({ error: `Već proknjiženo — ${d.proknjizio_ime || ''}.` });

    /* Knjizi se tek POSLIJE potvrde. Neproknjizen a nepotvrdjen dokument znacio bi
       da je u Bluesoft otislo nesto sto niko nije potvrdio da je izdato. */
    if (d.odobreno !== 'odobreno')
      return res.status(400).json({ error: 'Dokument prvo mora biti potvrđen, pa tek onda proknjižen.' });

    const r = await pool.query(
      `UPDATE magacin_dokumenti
       SET proknjizeno=true, proknjizio_id=$1, proknjizio_ime=$2, proknjizeno_kada=now()
       WHERE broj=$3 RETURNING *`,
      [u.id, u.ime_prezime, req.params.broj]
    );
    res.json({ ok: true, dokument: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
