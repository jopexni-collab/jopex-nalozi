const express = require('express');
const router = express.Router();
const pool = require('./db');
const bcrypt = require('bcryptjs');

// GET /api/zaposleni/ugovaraci
router.get('/ugovaraci', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, ime_prezime FROM zaposleni
       WHERE moze_ugovarati = true AND aktivan = true ORDER BY ime_prezime`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Greška.' });
  }
});

// POST /api/zaposleni - NOVI korisnik (samo admin). Lozinka se hash-uje ovdje (bcrypt) —
// zato ne postoji način da se ovo bezbjedno uradi direktno u bazi/SQL-om. Sva prava
// (moze_prodavati, izmjena_naloga, itd.) kreću isključena — admin ih uključuje POSLIJE
// kroz postojeće toggle-e u tabeli, isto kao za sve ostale korisnike.
router.post('/', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može dodavati korisnike.' });
  const { ime_prezime, email, lozinka, pozicija } = req.body;
  const rola = req.body.rola === 'admin' ? 'admin' : 'proizvodnja';
  if (!ime_prezime || !ime_prezime.trim())
    return res.status(400).json({ error: 'Ime i prezime su obavezni.' });
  if (!email || !email.trim())
    return res.status(400).json({ error: 'Email je obavezan.' });
  if (!lozinka || lozinka.length < 6)
    return res.status(400).json({ error: 'Lozinka mora imati bar 6 karaktera.' });
  try {
    const postoji = await pool.query('SELECT id FROM zaposleni WHERE LOWER(email)=LOWER($1)', [email.trim()]);
    if (postoji.rows.length) return res.status(400).json({ error: 'Korisnik sa tim email-om već postoji.' });
    const hash = await bcrypt.hash(lozinka, 10);
    const r = await pool.query(
      `INSERT INTO zaposleni (ime_prezime, email, lozinka, pozicija, rola, aktivan)
       VALUES ($1,$2,$3,$4,$5,true)
       RETURNING id, ime_prezime, email, pozicija, rola, aktivan`,
      [ime_prezime.trim(), email.trim(), hash, (pozicija || '').trim() || null, rola]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/zaposleni - lista svih (samo admin)
router.get('/', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const r = await pool.query(
      `SELECT z.id, z.ime_prezime, z.pozicija, z.rola, z.aktivan,
              z.moze_ugovarati, z.unos_naloga, z.izmjena_statusa, z.izmjena_naloga,
              z.moze_prodavati, z.moze_roba_magacin, z.email,
              COALESCE(
                (SELECT string_agg(p.naziv, ', ' ORDER BY p.naziv)
                 FROM blagajnici_pj b JOIN prodajni_objekti p ON p.id = b.objekat_id
                 WHERE b.zaposleni_id = z.id),
                ''
              ) AS blagajnik_pj_nazivi
       FROM zaposleni z ORDER BY z.ime_prezime`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Greška.' });
  }
});

// PATCH /api/zaposleni/:id
router.patch('/:id', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
 const ALLOWED = ['rola','aktivan','moze_ugovarati','unos_naloga','izmjena_statusa','izmjena_naloga','moze_prodavati','moze_roba_magacin','email','blagajnik_objekat_id'];
  const sets=[], vals=[];
  let i=1;
  for(const key of ALLOWED){
    if(key in req.body){ sets.push(`${key}=$${i++}`); vals.push(req.body[key]); }
  }
  if(!sets.length) return res.status(400).json({ error: 'Nema polja.' });
  vals.push(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE zaposleni SET ${sets.join(',')} WHERE id=$${i} RETURNING id`, vals
    );
    if(!r.rows.length) return res.status(404).json({ error: 'Nije pronađen.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

// POST /api/zaposleni/:id/lozinka
router.post('/:id/lozinka', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  const { lozinka } = req.body;
  if (!lozinka || lozinka.length < 6)
    return res.status(400).json({ error: 'Lozinka prekratka.' });
  try {
    const hash = await bcrypt.hash(lozinka, 10);
    await pool.query('UPDATE zaposleni SET lozinka=$1 WHERE id=$2', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška.' });
  }
});
// GET /api/zaposleni/:id/blagajnik-pj - PJ za koje je ovaj zaposleni blagajnik
router.get('/:id/blagajnik-pj', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const r = await pool.query('SELECT objekat_id FROM blagajnici_pj WHERE zaposleni_id=$1', [req.params.id]);
    res.json(r.rows.map(row => row.objekat_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/zaposleni/:id/blagajnik-pj - zamjenjuje kompletnu listu PJ za koje je ovaj
// zaposleni blagajnik (šalje se cijela nova lista, stara se briše i zamjenjuje).
// body: { objekat_idjevi: [1,3,5] }
router.put('/:id/blagajnik-pj', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  const objekatIdjevi = Array.isArray(req.body.objekat_idjevi) ? req.body.objekat_idjevi : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM blagajnici_pj WHERE zaposleni_id=$1', [req.params.id]);
    for (const objId of objekatIdjevi) {
      await client.query(
        'INSERT INTO blagajnici_pj (zaposleni_id, objekat_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [req.params.id, objId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, objekat_idjevi: objekatIdjevi });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// novi fajl
module.exports = router;
