const express = require('express');
const router = express.Router();
const pool = require('./db');
const crypto = require('crypto');

const RAZLOZI = ['kvalitet', 'kolicina', 'lom', 'jedinica', 'drugo'];

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true (dozvola iz korisnici.html).
// Primjenjuje se na SVE rute u ovom routeru — nijedna ovdje nije striktnije ograničena,
// admin samo vidi širi opseg (sve otpremnice) unutar istih ruta, ne posebnu rutu.
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
});

// Generiše broj otpremnice: OTP-YYYY-000123
async function noviBroj(client) {
  const godina = new Date().getFullYear();
  const seq = await client.query("SELECT nextval('otpremnica_broj_seq') AS n");
  const n = String(seq.rows[0].n).padStart(6, '0');
  return `OTP-${godina}-${n}`;
}

// Učitava trenutne (žive) podatke o robi za date roba_id-eve.
async function ucitajZivuRobu(client, roba_idjevi) {
  if (!roba_idjevi.length) return {};
  const r = await client.query(
    `SELECT id, sifra, naziv, jed_mjera, cijena, stanje FROM roba WHERE id = ANY($1::int[])`,
    [roba_idjevi]
  );
  const map = {};
  for (const row of r.rows) map[row.id] = row;
  return map;
}

// Sastavlja stavke na osnovu ŽIVIH podataka iz baze (cijena_zadana/naziv/stanje UVIJEK iz roba).
// Klijent šalje: roba_id, kolicina, jed_mjera_prodaja (kom/m2/m3 — trgovac SLOBODNO bira, jer
// se šifrarnik pri uvozu samo NAGAĐA — cijeli broj stanja => "kom", decimalan => "m2", a to
// nagađanje ne mora biti tačno za svaki artikal), opciono duzina_cm/visina_cm/debljina_cm (ako
// je količina izračunata preko kalkulatora), i OPCIONO override { tip, vrijednost, razlog,
// napomena } za ručno odstupanje od cijene.
//
// AUTOMATSKO SIGNALIZIRANJE: ako izabrana jedinica NE odgovara jedinici iz šifrarnika, stavka
// se automatski označava kao odstupanje (razlog 'jedinica'), bez obzira da li je trgovac ručno
// mijenjao cijenu — jer cijena artikla važi za zadanu jedinicu, pa prodaja u drugoj jedinici
// zaslužuje pregled kasnije (umjesto provjere unaprijed pri svakom uvozu).
function sastaviStavke(inputStavke, zivaRoba) {
  const DOZVOLJENE_JEDINICE = ['kom', 'm2', 'm3'];
  const stavke = [];
  for (const s of inputStavke) {
    const kolicina = parseFloat(s.kolicina);
    if (!s.roba_id || !kolicina || kolicina <= 0)
      throw Object.assign(new Error('Neispravna stavka u košarici.'), { status: 400 });
    const roba = zivaRoba[s.roba_id];
    if (!roba)
      throw Object.assign(new Error('Artikal više ne postoji u šifrarniku.'), { status: 400 });
    if (parseFloat(roba.stanje) < kolicina)
      throw Object.assign(
        new Error(`Nedovoljno stanje za "${roba.naziv}" (raspoloživo: ${roba.stanje} ${roba.jed_mjera}).`),
        { status: 400 }
      );

    const jedMjeraProdaja = DOZVOLJENE_JEDINICE.includes(s.jed_mjera_prodaja) ? s.jed_mjera_prodaja : roba.jed_mjera;
    const jedinicaOdstupa = jedMjeraProdaja !== roba.jed_mjera;

    const duzina_cm = s.duzina_cm != null && s.duzina_cm !== '' ? +parseFloat(s.duzina_cm).toFixed(2) : null;
    const visina_cm = s.visina_cm != null && s.visina_cm !== '' ? +parseFloat(s.visina_cm).toFixed(2) : null;
    const debljina_cm = s.debljina_cm != null && s.debljina_cm !== '' ? +parseFloat(s.debljina_cm).toFixed(2) : null;

    const cijenaZadana = parseFloat(roba.cijena);
    let cijena = cijenaZadana;
    let razlog = null, napomena = null;

    const ov = s.override;
    if (ov && (ov.tip === 'posto' || ov.tip === 'iznos') && ov.vrijednost !== '' && ov.vrijednost != null) {
      const vrijednost = parseFloat(ov.vrijednost);
      if (isNaN(vrijednost) || vrijednost < 0)
        throw Object.assign(new Error(`Neispravna vrijednost odstupanja za "${roba.naziv}".`), { status: 400 });
      if (!RAZLOZI.includes(ov.razlog))
        throw Object.assign(new Error(`Za odstupanje na "${roba.naziv}" morate izabrati razlog.`), { status: 400 });

      cijena = ov.tip === 'posto'
        ? +(cijenaZadana * (1 - vrijednost / 100)).toFixed(2)
        : +vrijednost.toFixed(2);
      if (cijena < 0) cijena = 0;
      razlog = ov.razlog;
      napomena = (ov.napomena || '').trim().slice(0, 500) || null;
    }

    const cijenaOdstupa = Math.abs(cijena - cijenaZadana) > 0.001;
    const odstupa = cijenaOdstupa || jedinicaOdstupa;

    let finalRazlog = null, finalNapomena = null;
    if (odstupa) {
      if (jedinicaOdstupa) {
        finalRazlog = razlog || 'jedinica';
        const autoNota = `⚙ Automatski signal: prodano po "${jedMjeraProdaja}" umjesto zadane jedinice "${roba.jed_mjera}" iz šifrarnika — provjeriti cijenu.`;
        finalNapomena = napomena ? `${autoNota} ${napomena}` : autoNota;
      } else {
        finalRazlog = razlog;
        finalNapomena = napomena;
      }
    }

    const iznos = +(kolicina * cijena).toFixed(2);
    stavke.push({
      roba_id: roba.id, sifra: roba.sifra, naziv: roba.naziv, jed_mjera: jedMjeraProdaja,
      kolicina, cijena_zadana: cijenaZadana, cijena, iznos,
      duzina_cm, visina_cm, debljina_cm,
      odstupa, razlog_odstupanja: finalRazlog, napomena_odstupanja: finalNapomena,
    });
  }
  return stavke;
}

// GET /api/otpremnice - lista (komercijalista vidi svoje, admin vidi sve)
router.get('/', async (req, res) => {
  try {
    const user = req.session?.user;
    const { status, od, do: do_, komercijalista_id, odstupanje } = req.query;
    let where = [];
    let vals = [];
    let i = 1;

    if (user?.rola !== 'admin') {
      where.push(`komercijalista_id = $${i++}`);
      vals.push(user.id);
    } else if (komercijalista_id) {
      where.push(`komercijalista_id = $${i++}`);
      vals.push(komercijalista_id);
    }
    if (status) { where.push(`status = $${i++}`); vals.push(status); }
    if (od) { where.push(`datum >= $${i++}`); vals.push(od); }
    if (do_) { where.push(`datum <= $${i++}`); vals.push(do_ + ' 23:59:59'); }
    if (odstupanje === 'true') { where.push(`ima_odstupanje = true`); }

    const sql = `SELECT * FROM otpremnice
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY datum DESC LIMIT 300`;
    const r = await pool.query(sql, vals);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/pregled - ŽIVI predračun (ne piše ništa u bazu)
// Koristi se kad komercijalista pritisne "Generiši otpremnicu" — pokazuje kupcu
// TRENUTNU cijenu i stanje (i eventualna odstupanja), bez zaključavanja bilo čega.
// body: { stavke: [{ roba_id, kolicina, override? }] }
router.post('/pregled', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const { stavke } = req.body;
  if (!Array.isArray(stavke) || !stavke.length)
    return res.status(400).json({ error: 'Košarica je prazna.' });

  try {
    const idjevi = stavke.map(s => s.roba_id).filter(Boolean);
    const zivaRoba = await ucitajZivuRobu(pool, idjevi);
    const sastavljene = sastaviStavke(stavke, zivaRoba);
    const ukupanIznos = +sastavljene.reduce((sum, s) => sum + s.iznos, 0).toFixed(2);
    const ukupnoZadano = +sastavljene.reduce((sum, s) => sum + s.kolicina * s.cijena_zadana, 0).toFixed(2);
    const imaOdstupanje = sastavljene.some(s => s.odstupa);
    res.json({
      stavke: sastavljene, ukupan_iznos: ukupanIznos, ukupno_zadano: ukupnoZadano,
      razlika: +(ukupanIznos - ukupnoZadano).toFixed(2), ima_odstupanje: imaOdstupanje,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/otpremnice/:id - zaglavlje + stavke
router.get('/:id', async (req, res) => {
  try {
    const user = req.session?.user;
    const h = await pool.query('SELECT * FROM otpremnice WHERE id=$1', [req.params.id]);
    if (!h.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    const otp = h.rows[0];
    if (user?.rola !== 'admin' && otp.komercijalista_id !== user.id)
      return res.status(403).json({ error: 'Nema pristupa.' });
    const s = await pool.query(
      'SELECT * FROM otpremnica_stavke WHERE otpremnica_id=$1 ORDER BY id', [req.params.id]
    );
    res.json({ ...otp, stavke: s.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/potvrdi - JEDINI trenutak kad se nešto upisuje.
// body: { stavke: [{ roba_id, kolicina, override? }], kupac_naziv, kupac_adresa,
//         kupac_telefon, kupac_email, kupac_grad, kupac_id, potvrdio_kupac_ime }
router.post('/potvrdi', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const { stavke, kupac_naziv, kupac_adresa, kupac_telefon, kupac_email, kupac_grad, kupac_id, potvrdio_kupac_ime } = req.body;
  if (!Array.isArray(stavke) || !stavke.length)
    return res.status(400).json({ error: 'Košarica je prazna.' });
  if (!potvrdio_kupac_ime || !potvrdio_kupac_ime.trim())
    return res.status(400).json({ error: 'Ime kupca je obavezno za potvrdu.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const idjevi = stavke.map(s => s.roba_id).filter(Boolean);
    if (idjevi.length) {
      await client.query('SELECT id FROM roba WHERE id = ANY($1::int[]) FOR UPDATE', [idjevi]);
    }
    const zivaRoba = await ucitajZivuRobu(client, idjevi);
    const sastavljene = sastaviStavke(stavke, zivaRoba);
    const ukupanIznos = +sastavljene.reduce((sum, s) => sum + s.iznos, 0).toFixed(2);
    const imaOdstupanje = sastavljene.some(s => s.odstupa);
    const javniToken = crypto.randomBytes(20).toString('hex');

    const broj = await noviBroj(client);
    const h = await client.query(
      `INSERT INTO otpremnice
         (broj, komercijalista_id, komercijalista_ime, kupac_id, kupac_naziv, kupac_adresa,
          kupac_telefon, kupac_email, kupac_grad, javni_token, ukupan_iznos,
          status, ima_odstupanje, potvrdio_kupac_ime, potvrdjeno_vrijeme)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'potvrdjena',$12,$13, now()) RETURNING *`,
      [broj, user.id, user.ime_prezime, kupac_id || null, kupac_naziv || null, kupac_adresa || null,
       kupac_telefon || null, kupac_email || null, kupac_grad || null, javniToken, ukupanIznos,
       imaOdstupanje, potvrdio_kupac_ime.trim()]
    );
    const otpId = h.rows[0].id;

    for (const s of sastavljene) {
      await client.query(
        `INSERT INTO otpremnica_stavke
           (otpremnica_id, roba_id, sifra, naziv, jed_mjera, kolicina,
            cijena_zadana, cijena, iznos, razlog_odstupanja, napomena_odstupanja,
            duzina_cm, visina_cm, debljina_cm)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [otpId, s.roba_id, s.sifra, s.naziv, s.jed_mjera, s.kolicina,
         s.cijena_zadana, s.cijena, s.iznos, s.razlog_odstupanja, s.napomena_odstupanja,
         s.duzina_cm, s.visina_cm, s.debljina_cm]
      );
      await client.query(
        'UPDATE roba SET stanje = stanje - $1, azurirano = now() WHERE id=$2',
        [s.kolicina, s.roba_id]
      );
    }

    const g = await client.query(
      `INSERT INTO gotovina (datum, iznos, primio, izvor, opis)
       VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3) RETURNING id`,
      [ukupanIznos, user.ime_prezime, `Otpremnica ${broj}`]
    );
    await client.query('UPDATE otpremnice SET gotovina_id=$1 WHERE id=$2', [g.rows[0].id, otpId]);

    await client.query('COMMIT');
    res.status(201).json({ ...h.rows[0], gotovina_id: g.rows[0].id, stavke: sastavljene });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
