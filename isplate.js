const express = require('express');
const router = express.Router();
const pool = require('./db');
const crypto = require('crypto');

const RAZLOZI = ['povrat_komitentu', 'gorivo', 'sitne_popravke', 'dorucak', 'cistac', 'servis', 'drugo'];

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true (ista dozvola kao za otpremnice,
// jer su isplate dio istog dnevnog gotovinskog obračuna maloprodaje).
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
});

// GET /api/isplate?objekt_id=X&od=&do= - lista (komercijalista svoje, admin sve)
router.get('/', async (req, res) => {
  try {
    const user = req.session.user;
    const { objekt_id, od, do: do_ } = req.query;
    let where = [];
    let vals = [];
    let i = 1;

    if (user.rola !== 'admin') { where.push(`komercijalista_id = $${i++}`); vals.push(user.id); }
    if (objekt_id) { where.push(`objekt_id = $${i++}`); vals.push(objekt_id); }
    if (od) { where.push(`datum >= $${i++}`); vals.push(od); }
    if (do_) { where.push(`datum <= $${i++}`); vals.push(do_ + ' 23:59:59'); }

    const sql = `SELECT * FROM isplate
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY datum DESC LIMIT 300`;
    const r = await pool.query(sql, vals);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/isplate/suma?objekt_id=X&od=&do= - suma za period (za "Zaključi dan" neto obračun)
router.get('/suma', async (req, res) => {
  try {
    const user = req.session.user;
    const { objekt_id, od, do: do_ } = req.query;
    let where = [];
    let vals = [];
    let i = 1;

    if (user.rola !== 'admin') { where.push(`komercijalista_id = $${i++}`); vals.push(user.id); }
    if (objekt_id) { where.push(`objekt_id = $${i++}`); vals.push(objekt_id); }
    if (od) { where.push(`datum >= $${i++}`); vals.push(od); }
    if (do_) { where.push(`datum <= $${i++}`); vals.push(do_ + ' 23:59:59'); }

    const sql = `SELECT COALESCE(SUM(iznos),0) AS ukupno, COUNT(*) AS broj FROM isplate
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const r = await pool.query(sql, vals);
    res.json({ ukupno: +parseFloat(r.rows[0].ukupno).toFixed(2), broj: parseInt(r.rows[0].broj) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const RAZLOG_LABEL = {
  povrat_komitentu: 'Povrat komitentu', gorivo: 'Gorivo', sitne_popravke: 'Sitne popravke',
  dorucak: 'Trošak doručka', cistac: 'Trošak čistača', servis: 'Servis', drugo: 'Drugo',
};

// POST /api/isplate - nova isplata, potvrđena od primaoca (jedini trenutak upisa).
// Upisuje se i u "isplate" (detaljan zapis) i u "gotovina" (kao NEGATIVAN iznos, izvor
// 'Maloprodaja') — istom logikom kao prodaja (otpremnice.js) — da blagajna prikazuje
// kompletnu sliku, ne samo prodaju.
// body: { objekt_id, iznos, razlog, napomena, primalac_ime }
router.post('/', async (req, res) => {
  const user = req.session.user;
  const { objekt_id, iznos, razlog, napomena, primalac_ime } = req.body;

  if (!objekt_id) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
  const izn = parseFloat(iznos);
  if (!izn || izn <= 0) return res.status(400).json({ error: 'Unesite ispravan iznos.' });
  if (!RAZLOZI.includes(razlog)) return res.status(400).json({ error: 'Neispravan razlog isplate.' });
  if (!primalac_ime || !primalac_ime.trim())
    return res.status(400).json({ error: 'Ime primaoca je obavezno za potvrdu isplate.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const objRes = await client.query('SELECT naziv FROM prodajni_objekti WHERE id=$1', [objekt_id]);
    if (!objRes.rows.length) throw Object.assign(new Error('Prodajni objekat nije pronađen.'), { status: 404 });
    const objektNaziv = objRes.rows[0].naziv;
    const napomenaTrim = (napomena || '').trim() || null;
    const javniToken = crypto.randomBytes(20).toString('hex');

    const r = await client.query(
      `INSERT INTO isplate
         (objekt_id, objekt_naziv, iznos, razlog, napomena, primalac_ime,
          potvrdjeno_vrijeme, komercijalista_id, komercijalista_ime, javni_token)
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7,$8,$9) RETURNING *`,
      [objekt_id, objektNaziv, izn, razlog, napomenaTrim, primalac_ime.trim(), user.id, user.ime_prezime, javniToken]
    );
    const isplata = r.rows[0];

    const opis = `Isplata — ${RAZLOG_LABEL[razlog]} — ${primalac_ime.trim()}${napomenaTrim ? ' (' + napomenaTrim + ')' : ''}`;
    const g = await client.query(
      `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv, nalog_r_br, javni_token)
       VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3, $4, $5, $6) RETURNING id`,
      [-izn, user.ime_prezime, opis, objektNaziv, `ISP-${isplata.id}`, javniToken]
    );

    await client.query('COMMIT');
    res.status(201).json({ ...isplata, gotovina_id: g.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/isplate/:id - samo admin (ispravka greške u unosu) — briše i povezan red u gotovini
router.delete('/:id', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može brisati isplate.' });
  try {
    await pool.query('DELETE FROM gotovina WHERE nalog_r_br=$1 AND izvor=$2', [`ISP-${req.params.id}`, 'Maloprodaja']);
    await pool.query('DELETE FROM isplate WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
