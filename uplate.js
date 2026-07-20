const express = require('express');
const router = express.Router();
const pool = require('./db');
const crypto = require('crypto');

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true (isti krug ljudi kao za
// prodaju/isplate — komercijalista NEMA direktan pristup gotovina.html, ovo mu je posredan
// način da unese uplatu koja se ipak evidentira u blagajni).
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
});

// GET /api/uplate?objekt_id=X&od=&do= - lista uplata
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
    const sql = `SELECT * FROM kupac_transakcije
      WHERE tip IN ('avans_uplata','naplata_duga') ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY datum DESC LIMIT 300`;
    const r = await pool.query(sql, vals);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/uplate/suma?objekt_id=&od=&do= - suma uplata za period (za kartice danas/sedmica/period)
router.get('/suma', async (req, res) => {
  try {
    const user = req.session.user;
    const { objekt_id, od, do: do_ } = req.query;
    let where = [`tip IN ('avans_uplata','naplata_duga')`];
    let vals = [];
    let i = 1;
    if (user.rola !== 'admin') { where.push(`komercijalista_id = $${i++}`); vals.push(user.id); }
    if (objekt_id) { where.push(`objekt_id = $${i++}`); vals.push(objekt_id); }
    if (od) { where.push(`datum >= $${i++}`); vals.push(od); }
    if (do_) { where.push(`datum <= $${i++}`); vals.push(do_ + ' 23:59:59'); }
    const sql = `SELECT COALESCE(SUM(iznos),0) AS ukupno, COUNT(*) AS broj FROM kupac_transakcije
      WHERE ${where.join(' AND ')}`;
    const r = await pool.query(sql, vals);
    res.json({ ukupno: +parseFloat(r.rows[0].ukupno).toFixed(2), broj: parseInt(r.rows[0].broj) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/uplate/ne-saldirano - ukupan zbir SVIH pozitivnih saldi (neiskorišćeni avansi)
// preko svih kupaca — za karticu "Ne saldirane uplate" u Uplata tabu.
router.get('/ne-saldirano', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(saldo),0) AS ukupno, COUNT(*) AS broj FROM (
         SELECT t.kupac_id,
           SUM(CASE WHEN p.valuta = 'EUR' THEN t.iznos * 1.95 ELSE t.iznos END) AS saldo
         FROM kupac_transakcije t
         LEFT JOIN prodajni_objekti p ON p.id = t.objekt_id
         GROUP BY t.kupac_id HAVING SUM(CASE WHEN p.valuta = 'EUR' THEN t.iznos * 1.95 ELSE t.iznos END) > 0
       ) t`
    );
    res.json({ ukupno: +parseFloat(r.rows[0].ukupno).toFixed(2), broj: parseInt(r.rows[0].broj) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/uplate - nova uplata od kupca. Ako kupac ima otvoren dug (negativan saldo,
// tj. neplaćene otpremnice), uplata se PRVO koristi da ga pokrije (najstarije prvo);
// ostatak (ako ga ima) ostaje kao čist avans na kartici kupca.
// body: { objekt_id, kupac_id, iznos, napomena }
router.post('/', async (req, res) => {
  const user = req.session.user;
  const { objekt_id, kupac_id, napomena } = req.body;
  const iznos = parseFloat(req.body.iznos);

  if (!objekt_id) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
  if (!kupac_id) return res.status(400).json({ error: 'Nedostaje kupac.' });
  if (!iznos || iznos <= 0) return res.status(400).json({ error: 'Unesite ispravan iznos.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const objRes = await client.query('SELECT naziv FROM prodajni_objekti WHERE id=$1', [objekt_id]);
    if (!objRes.rows.length) throw Object.assign(new Error('Prodajni objekat nije pronađen.'), { status: 404 });
    const objektNaziv = objRes.rows[0].naziv;
    const objektValuta = objRes.rows[0].valuta || 'KM';

    const kupacRes = await client.query('SELECT naziv FROM kupci WHERE id=$1', [kupac_id]);
    if (!kupacRes.rows.length) throw Object.assign(new Error('Kupac nije pronađen.'), { status: 404 });
    const kupacNaziv = kupacRes.rows[0].naziv;

    // Cijeli iznos ulazi u blagajnu odjednom — SVJEŽA gotovina, bez obzira šta se dalje
    // dešava sa raspodjelom (pokrivanje duga vs. avans).
    const g = await client.query(
      `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv)
       VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3, $4) RETURNING id`,
      [iznos, user.ime_prezime, `Uplata — ${kupacNaziv}${napomena ? ' (' + napomena.trim() + ')' : ''}`, objektNaziv]
    );
    const gotovinaId = g.rows[0].id;
    // Isti pattern kao ISP- za isplate — daje koloni "Nalog/Otp" u blagajni prepoznatljiv
    // identifikator i za uplate (do sad je ta kolona ostajala prazna za uplate).
    await client.query('UPDATE gotovina SET nalog_r_br=$1 WHERE id=$2', [`UPL-${gotovinaId}`, gotovinaId]);

    let preostalo = iznos;
    const pokriveneOtpremnice = [];

    // Pronađi sve NEPLAĆENE otpremnice ovog kupca U ISTOJ VALUTI kao ovaj PJ, najstarije
    // prvo, i pokrivaj dug redom. Dug u drugoj valuti (npr. EUR dug kad je ova uplata u KM)
    // se NE dira — ne konvertujemo tiho preko duga, samo preko poznatog fiksnog kursa i to
    // samo kad je to jasno namjeravano (avans-primjena na prodaji, ne ovdje automatski).
    const dugRes = await client.query(
      `SELECT o.id, o.broj, o.ukupan_iznos, o.iznos_placeno, o.objekt_id, o.objekt_naziv
       FROM otpremnice o
       LEFT JOIN prodajni_objekti p ON p.id = o.objekt_id
       WHERE o.kupac_id=$1 AND o.status='potvrdjena' AND o.status_placanja != 'placeno'
         AND COALESCE(p.valuta,'KM') = $2
       ORDER BY o.datum ASC FOR UPDATE OF o`,
      [kupac_id, objektValuta]
    );
    for (const otp of dugRes.rows) {
      if (preostalo <= 0) break;
      const duguje = +(parseFloat(otp.ukupan_iznos) - parseFloat(otp.iznos_placeno)).toFixed(2);
      if (duguje <= 0) continue;
      const pokrivamo = +Math.min(preostalo, duguje).toFixed(2);

      const noviIznosPlaceno = +(parseFloat(otp.iznos_placeno) + pokrivamo).toFixed(2);
      const noviStatus = noviIznosPlaceno >= parseFloat(otp.ukupan_iznos) ? 'placeno' : 'djelimicno';
      await client.query(
        'UPDATE otpremnice SET iznos_placeno=$1, status_placanja=$2 WHERE id=$3',
        [noviIznosPlaceno, noviStatus, otp.id]
      );
      await client.query(
        `INSERT INTO kupac_transakcije
           (kupac_id, tip, iznos, opis, otpremnica_id, otpremnica_broj, objekt_id, objekt_naziv,
            komercijalista_id, komercijalista_ime, gotovina_id)
         VALUES ($1,'naplata_duga',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [kupac_id, pokrivamo, `Uplata pokriva dug za ${otp.broj}`, otp.id, otp.broj,
         otp.objekt_id, otp.objekt_naziv, user.id, user.ime_prezime, gotovinaId]
      );
      pokriveneOtpremnice.push({ broj: otp.broj, pokriveno: pokrivamo });
      preostalo = +(preostalo - pokrivamo).toFixed(2);
    }

    // Ostatak (ako išta preostane nakon pokrivanja svih dugova) postaje čist avans.
    let avansToken = null;
    if (preostalo > 0) {
      avansToken = crypto.randomBytes(20).toString('hex');
      await client.query(
        `INSERT INTO kupac_transakcije
           (kupac_id, tip, iznos, opis, objekt_id, objekt_naziv,
            komercijalista_id, komercijalista_ime, gotovina_id, javni_token)
         VALUES ($1,'avans_uplata',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [kupac_id, preostalo, napomena || 'Avansna uplata', objekt_id, objektNaziv,
         user.id, user.ime_prezime, gotovinaId, avansToken]
      );
      // Isti token i na gotovina red — da gotovina.html može direktno linkovati na
      // dokument "Potvrda o uplati", isti pattern kao za isplate.
      await client.query('UPDATE gotovina SET javni_token=$1 WHERE id=$2', [avansToken, gotovinaId]);
    }

    await client.query('COMMIT');
    res.status(201).json({
      ok: true, iznos, pokriveno_duga: +(iznos - preostalo).toFixed(2), ostatak_kao_avans: preostalo,
      pokrivene_otpremnice: pokriveneOtpremnice, javni_token: avansToken, kupac_naziv: kupacNaziv,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
