const express = require('express');
const router = express.Router();
const pool = require('./db');
const crypto = require('crypto');

const RAZLOZI = ['kvalitet', 'kolicina', 'lom', 'jedinica', 'drugo'];

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true (dozvola iz korisnici.html).
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
});

function trebaObjekat(id) {
  const n = parseInt(id);
  return n > 0 ? n : null;
}

// Generiše broj otpremnice: OTP-YYYY-000123
async function noviBroj(client) {
  const godina = new Date().getFullYear();
  const seq = await client.query("SELECT nextval('otpremnica_broj_seq') AS n");
  const n = String(seq.rows[0].n).padStart(6, '0');
  return `OTP-${godina}-${n}`;
}

// Isti brojač, ali sa DUG- prefiksom — koristi se SAMO za ručno unesene, istorijske
// dugove (bez prave prodaje kroz sistem), da se jasno razlikuju od stvarnih OTP- prodaja
// na svakom pregledu (npr. lista otpremnica, blagajna).
async function noviBrojDug(client) {
  const godina = new Date().getFullYear();
  const seq = await client.query("SELECT nextval('otpremnica_broj_seq') AS n");
  const n = String(seq.rows[0].n).padStart(6, '0');
  return `DUG-${godina}-${n}`;
}

// Učitava trenutne (žive) podatke o robi ZA DATI PRODAJNI OBJEKAT (cijena/stanje su po PJ).
async function ucitajZivuRobu(client, roba_idjevi, objektId) {
  if (!roba_idjevi.length) return {};
  const r = await client.query(
    `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, rp.cijena, rp.stanje
     FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$2
     WHERE r.id = ANY($1::int[])`,
    [roba_idjevi, objektId]
  );
  const map = {};
  for (const row of r.rows) map[row.id] = row;
  return map;
}

// Sastavlja stavke na osnovu ŽIVIH podataka iz baze (cijena_zadana/naziv/stanje UVIJEK iz
// roba+roba_pj ZA IZABRANI PRODAJNI OBJEKAT — svaki PJ ima svoju cijenu i svoje stanje).
// Klijent šalje: roba_id, kolicina, jed_mjera_prodaja (kom/m2/m3 — trgovac SLOBODNO bira, jer
// se šifrarnik pri uvozu samo NAGAĐA), opciono duzina_cm/visina_cm/debljina_cm, i OPCIONO
// override { tip, vrijednost, razlog, napomena } za ručno odstupanje od cijene.
//
// AUTOMATSKO SIGNALIZIRANJE: ako izabrana jedinica NE odgovara jedinici iz šifrarnika, stavka
// se automatski označava kao odstupanje (razlog 'jedinica').
function sastaviStavke(inputStavke, zivaRoba) {
  const DOZVOLJENE_JEDINICE = ['kom', 'm2', 'm3'];
  const stavke = [];
  for (const s of inputStavke) {
    const kolicina = parseFloat(s.kolicina);
    if (!s.roba_id || !kolicina || kolicina <= 0)
      throw Object.assign(new Error('Neispravna stavka u košarici.'), { status: 400 });
    const roba = zivaRoba[s.roba_id];
    if (!roba)
      throw Object.assign(new Error('Artikal nije dostupan (ili nema cijenu/stanje) u ovom prodajnom objektu.'), { status: 400 });
    if (parseFloat(roba.stanje) < kolicina) {
      const raspolozivo = parseFloat(roba.stanje);
      const nedostaje = +(kolicina - raspolozivo).toFixed(3);
      throw Object.assign(
        new Error(
          `Nedovoljno stanje za "${roba.naziv}": traženo ${kolicina} ${roba.jed_mjera}, ` +
          `raspoloživo ${raspolozivo} ${roba.jed_mjera} — nedostaje ${nedostaje} ${roba.jed_mjera}.`
        ),
        { status: 400, artikal: roba.naziv, trazeno: kolicina, raspolozivo, nedostaje, jed_mjera: roba.jed_mjera }
      );
    }

    const jedMjeraProdaja = DOZVOLJENE_JEDINICE.includes(s.jed_mjera_prodaja) ? s.jed_mjera_prodaja : roba.jed_mjera;
    const jedinicaOdstupa = jedMjeraProdaja !== roba.jed_mjera;

    const duzina_cm = s.duzina_cm != null && s.duzina_cm !== '' ? +parseFloat(s.duzina_cm).toFixed(2) : null;
    const visina_cm = s.visina_cm != null && s.visina_cm !== '' ? +parseFloat(s.visina_cm).toFixed(2) : null;
    const debljina_cm = s.debljina_cm != null && s.debljina_cm !== '' ? +parseFloat(s.debljina_cm).toFixed(2) : null;
    const broj_komada = s.broj_komada != null && s.broj_komada !== '' ? Math.max(1, parseInt(s.broj_komada)) : null;

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
      duzina_cm, visina_cm, debljina_cm, broj_komada,
      odstupa, razlog_odstupanja: finalRazlog, napomena_odstupanja: finalNapomena,
    });
  }
  return stavke;
}

// GET /api/otpremnice - lista (komercijalista vidi svoje, admin vidi sve; opciono ?objekt_id=)
router.get('/', async (req, res) => {
  try {
    const user = req.session?.user;
    const { status, od, do: do_, komercijalista_id, odstupanje, objekt_id, broj } = req.query;
    let where = [];
    let vals = [];
    let i = 1;

    // "broj" (deep-link iz blagajne, npr. klik na OTP broj) — admin vidi BILO KOJU
    // otpremnicu po broju, bez obzira ko ju je napravio; ostali i dalje samo svoje.
    if (broj) {
      where.push(`broj = $${i++}`);
      vals.push(broj);
      if (user?.rola !== 'admin') { where.push(`komercijalista_id = $${i++}`); vals.push(user.id); }
    } else if (user?.rola !== 'admin') {
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
    if (objekt_id) { where.push(`objekt_id = $${i++}`); vals.push(objekt_id); }

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
// body: { objekt_id, stavke: [{ roba_id, kolicina, override? }] }
router.post('/pregled', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const objektId = trebaObjekat(req.body.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
  const { stavke } = req.body;
  if (!Array.isArray(stavke) || !stavke.length)
    return res.status(400).json({ error: 'Košarica je prazna.' });

  try {
    const idjevi = stavke.map(s => s.roba_id).filter(Boolean);
    const zivaRoba = await ucitajZivuRobu(pool, idjevi, objektId);
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

// POST /api/otpremnice/potvrdi - JEDINI trenutak kad se otpremnica upisuje.
// body: { objekt_id, stavke: [...], kupac_naziv, kupac_adresa, kupac_telefon, kupac_email,
//         kupac_grad, kupac_id, potvrdio_kupac_ime, nacin_placanja, iznos_placeno_sada }
// nacin_placanja: 'kompletno' (podrazumijevano, cio iznos odmah) | 'djelimicno' (unosi se
// iznos_placeno_sada, ostatak ide na dug) | 'dug' (ništa se ne plaća sad, sve na dug).
router.post('/potvrdi', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const objektId = trebaObjekat(req.body.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
  const {
    stavke, kupac_naziv, kupac_adresa, kupac_telefon, kupac_email, kupac_grad, kupac_id,
    potvrdio_kupac_ime, nacin_placanja, iznos_placeno_sada,
  } = req.body;
  if (!Array.isArray(stavke) || !stavke.length)
    return res.status(400).json({ error: 'Košarica je prazna.' });
  if (!potvrdio_kupac_ime || !potvrdio_kupac_ime.trim())
    return res.status(400).json({ error: 'Ime kupca je obavezno za potvrdu.' });
  const nacin = ['kompletno', 'djelimicno', 'dug'].includes(nacin_placanja) ? nacin_placanja : 'kompletno';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const objRes = await client.query('SELECT naziv FROM prodajni_objekti WHERE id=$1 AND aktivan=true', [objektId]);
    if (!objRes.rows.length) throw Object.assign(new Error('Prodajni objekat nije pronađen ili nije aktivan.'), { status: 400 });
    const objektNaziv = objRes.rows[0].naziv;

    const idjevi = stavke.map(s => s.roba_id).filter(Boolean);
    if (idjevi.length) {
      // Zaključaj roba_pj redove za ovaj PJ (ne cijeli roba) da spriječimo trku na stanju.
      await client.query(
        'SELECT id FROM roba_pj WHERE roba_id = ANY($1::int[]) AND objekt_id=$2 FOR UPDATE',
        [idjevi, objektId]
      );
    }
    const zivaRoba = await ucitajZivuRobu(client, idjevi, objektId);
    const sastavljene = sastaviStavke(stavke, zivaRoba);
    const ukupanIznos = +sastavljene.reduce((sum, s) => sum + s.iznos, 0).toFixed(2);
    const imaOdstupanje = sastavljene.some(s => s.odstupa);
    const javniToken = crypto.randomBytes(20).toString('hex');

    // Iznos koji se STVARNO plaća u ovom trenutku — zavisi od načina plaćanja.
    let iznosPlaceno;
    if (nacin === 'kompletno') iznosPlaceno = ukupanIznos;
    else if (nacin === 'dug') iznosPlaceno = 0;
    else { // djelimicno
      iznosPlaceno = parseFloat(iznos_placeno_sada);
      if (isNaN(iznosPlaceno) || iznosPlaceno < 0)
        throw Object.assign(new Error('Unesite ispravan iznos koji kupac plaća sada.'), { status: 400 });
      if (iznosPlaceno > ukupanIznos)
        throw Object.assign(new Error('Iznos koji kupac plaća sada ne može biti veći od ukupnog iznosa otpremnice.'), { status: 400 });
    }
    iznosPlaceno = +iznosPlaceno.toFixed(2);
    const statusPlacanja = iznosPlaceno >= ukupanIznos ? 'placeno' : (iznosPlaceno > 0 ? 'djelimicno' : 'duguje');

    const broj = await noviBroj(client);
    const h = await client.query(
      `INSERT INTO otpremnice
         (broj, komercijalista_id, komercijalista_ime, objekt_id, objekt_naziv,
          kupac_id, kupac_naziv, kupac_adresa, kupac_telefon, kupac_email, kupac_grad,
          javni_token, ukupan_iznos, status, ima_odstupanje, potvrdio_kupac_ime, potvrdjeno_vrijeme,
          iznos_placeno, status_placanja)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'potvrdjena',$14,$15, now(), $16,$17) RETURNING *`,
      [broj, user.id, user.ime_prezime, objektId, objektNaziv,
       kupac_id || null, kupac_naziv || null, kupac_adresa || null,
       kupac_telefon || null, kupac_email || null, kupac_grad || null, javniToken, ukupanIznos,
       imaOdstupanje, potvrdio_kupac_ime.trim(), iznosPlaceno, statusPlacanja]
    );
    const otpId = h.rows[0].id;

    for (const s of sastavljene) {
      await client.query(
        `INSERT INTO otpremnica_stavke
           (otpremnica_id, roba_id, sifra, naziv, jed_mjera, kolicina,
            cijena_zadana, cijena, iznos, razlog_odstupanja, napomena_odstupanja,
            duzina_cm, visina_cm, debljina_cm, broj_komada)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [otpId, s.roba_id, s.sifra, s.naziv, s.jed_mjera, s.kolicina,
         s.cijena_zadana, s.cijena, s.iznos, s.razlog_odstupanja, s.napomena_odstupanja,
         s.duzina_cm, s.visina_cm, s.debljina_cm, s.broj_komada]
      );
      // Stanje se smanjuje SAMO za ovaj prodajni objekat (roba_pj), ne globalno.
      // Napomena: roba IZLAZI iz magacina bez obzira na način plaćanja (i kad je na dug) —
      // to se ovdje namjerno ne mijenja, dug je isključivo pitanje novca, ne robe.
      await client.query(
        'UPDATE roba_pj SET stanje = stanje - $1, azurirano = now() WHERE roba_id=$2 AND objekt_id=$3',
        [s.kolicina, s.roba_id, objektId]
      );
    }

    const opisKupca = kupac_naziv ? kupac_naziv.trim() : 'kupac nepoznat';
    // U blagajnu ide SAMO ono što je stvarno plaćeno SAD — ne cio ukupan_iznos ako je
    // djelimično/na dug. Ako ništa nije plaćeno (nacin='dug'), gotovina se uopšte ne dira.
    let gotovinaId = null;
    if (iznosPlaceno > 0) {
      const opisSuffiks = statusPlacanja === 'djelimicno' ? ' (djelimično plaćanje)' : '';
      const g = await client.query(
        `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv, nalog_r_br)
         VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3, $4, $5) RETURNING id`,
        [iznosPlaceno, user.ime_prezime, opisKupca + opisSuffiks, objektNaziv, broj]
      );
      gotovinaId = g.rows[0].id;
      await client.query('UPDATE otpremnice SET gotovina_id=$1 WHERE id=$2', [gotovinaId, otpId]);
    }

    await client.query('COMMIT');
    res.status(201).json({ ...h.rows[0], gotovina_id: gotovinaId, stavke: sastavljene, iznos_placeno: iznosPlaceno, status_placanja: statusPlacanja, duguje: +(ukupanIznos - iznosPlaceno).toFixed(2) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/otpremnice/dugovanja?objekt_id=X - lista otpremnica koje nisu u potpunosti
// plaćene. Vidljivo SVIM komercijalistima (ne samo onom ko je napravio prodaju) — kupac
// može doći da plati bilo kom, bilo kad.
router.get('/dugovanja/lista', async (req, res) => {
  try {
    const { objekt_id } = req.query;
    let where = [`status_placanja != 'placeno'`, `status = 'potvrdjena'`];
    let vals = [];
    let i = 1;
    if (objekt_id) { where.push(`objekt_id = $${i++}`); vals.push(objekt_id); }
    const r = await pool.query(
      `SELECT id, broj, datum, kupac_id, kupac_naziv, kupac_telefon, objekt_naziv,
              komercijalista_ime, ukupan_iznos, iznos_placeno, status_placanja,
              (ukupan_iznos - iznos_placeno) AS duguje
       FROM otpremnice WHERE ${where.join(' AND ')} ORDER BY datum ASC`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/otpremnice/dugovanja/kupac/:kupac_id - ukupan dug jednog kupca preko svih
// njegovih otpremnica (bilo koji PJ) — "koliko mi Petar duguje ukupno".
router.get('/dugovanja/kupac/:kupac_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, broj, datum, objekt_naziv, komercijalista_ime,
              ukupan_iznos, iznos_placeno, status_placanja,
              (ukupan_iznos - iznos_placeno) AS duguje
       FROM otpremnice
       WHERE kupac_id = $1 AND status = 'potvrdjena' AND status_placanja != 'placeno'
       ORDER BY datum ASC`,
      [req.params.kupac_id]
    );
    const ukupnoDuguje = r.rows.reduce((s, o) => s + parseFloat(o.duguje), 0);
    res.json({ stavke: r.rows, ukupno_duguje: +ukupnoDuguje.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/:id/naplati-dug - bilježi novu (djelimičnu ili potpunu) naplatu
// duga za jednu otpremnicu. Novac ulazi u blagajnu NA DAN kad je stvarno naplaćen (danas),
// ne na dan prodaje.
// body: { iznos }
router.post('/:id/naplati-dug', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const iznos = parseFloat(req.body.iznos);
  if (!iznos || iznos <= 0) return res.status(400).json({ error: 'Unesite ispravan iznos.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM otpremnice WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!r.rows.length) throw Object.assign(new Error('Otpremnica nije pronađena.'), { status: 404 });
    const otp = r.rows[0];
    const trenutnoDuguje = +(parseFloat(otp.ukupan_iznos) - parseFloat(otp.iznos_placeno)).toFixed(2);
    if (trenutnoDuguje <= 0)
      throw Object.assign(new Error('Ova otpremnica je već u potpunosti plaćena.'), { status: 400 });
    if (iznos > trenutnoDuguje)
      throw Object.assign(new Error(`Iznos ne može biti veći od trenutnog duga (${trenutnoDuguje} KM).`), { status: 400 });

    const noviIznosPlaceno = +(parseFloat(otp.iznos_placeno) + iznos).toFixed(2);
    const noviStatus = noviIznosPlaceno >= parseFloat(otp.ukupan_iznos) ? 'placeno' : 'djelimicno';

    await client.query(
      'UPDATE otpremnice SET iznos_placeno=$1, status_placanja=$2 WHERE id=$3',
      [noviIznosPlaceno, noviStatus, otp.id]
    );

    const opisKupca = otp.kupac_naziv ? otp.kupac_naziv.trim() : 'kupac nepoznat';
    const g = await client.query(
      `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv, nalog_r_br)
       VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3, $4, $5) RETURNING id`,
      [iznos, user.ime_prezime, `Naplata duga — ${opisKupca}`, otp.objekt_naziv, otp.broj]
    );

    await client.query('COMMIT');
    res.json({
      ok: true, otpremnica_id: otp.id, broj: otp.broj, naplaceno_sada: iznos,
      iznos_placeno: noviIznosPlaceno, status_placanja: noviStatus,
      preostalo_duguje: +(parseFloat(otp.ukupan_iznos) - noviIznosPlaceno).toFixed(2),
      gotovina_id: g.rows[0].id,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/otpremnice/rucni-dug - RUČNI unos istorijskog duga (nastao PRIJE uvođenja
// ovog sistema, npr. iz Excel/papirne evidencije) — BEZ stavki robe i BEZ diranja stanja
// (roba je odavno izašla nekim drugim putem, ne kroz ovaj sistem). Samo admin, jer je ovo
// administrativna korekcija/uvoz podataka, ne stvarna prodaja.
// body: { objekt_id, kupac_naziv, kupac_id, ukupan_iznos, iznos_vec_placeno, datum, napomena }
router.post('/rucni-dug', async (req, res) => {
  const user = req.session?.user;
  if (user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može ručno unositi istorijske dugove.' });

  const objektId = trebaObjekat(req.body.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
  const { kupac_naziv, kupac_id, napomena } = req.body;
  const ukupanIznos = parseFloat(req.body.ukupan_iznos);
  const iznosVecPlaceno = parseFloat(req.body.iznos_vec_placeno) || 0;
  const datum = req.body.datum || null; // opciono — dozvoljava unos sa STARIM datumom

  if (!ukupanIznos || ukupanIznos <= 0)
    return res.status(400).json({ error: 'Unesite ispravan ukupan iznos.' });
  if (iznosVecPlaceno < 0 || iznosVecPlaceno > ukupanIznos)
    return res.status(400).json({ error: 'Već plaćeni iznos mora biti između 0 i ukupnog iznosa.' });
  if (!kupac_naziv || !kupac_naziv.trim())
    return res.status(400).json({ error: 'Naziv/ime kupca je obavezno.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const objRes = await client.query('SELECT naziv FROM prodajni_objekti WHERE id=$1', [objektId]);
    if (!objRes.rows.length) throw Object.assign(new Error('Prodajni objekat nije pronađen.'), { status: 404 });
    const objektNaziv = objRes.rows[0].naziv;

    const statusPlacanja = iznosVecPlaceno >= ukupanIznos ? 'placeno' : (iznosVecPlaceno > 0 ? 'djelimicno' : 'duguje');
    const broj = await noviBrojDug(client);
    const javniToken = crypto.randomBytes(20).toString('hex');

    const h = await client.query(
      `INSERT INTO otpremnice
         (broj, komercijalista_id, komercijalista_ime, objekt_id, objekt_naziv,
          kupac_id, kupac_naziv, javni_token, ukupan_iznos, status, ima_odstupanje,
          potvrdio_kupac_ime, potvrdjeno_vrijeme, iznos_placeno, status_placanja,
          napomena, rucni_unos, datum)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'potvrdjena',false,$10, now(), $11,$12,$13,true, COALESCE($14, now()))
       RETURNING *`,
      [broj, user.id, user.ime_prezime, objektId, objektNaziv,
       kupac_id || null, kupac_naziv.trim(), javniToken, ukupanIznos,
       '(ručni unos — ' + user.ime_prezime + ')', iznosVecPlaceno, statusPlacanja,
       napomena || null, datum]
    );

    // NAPOMENA: iznos_vec_placeno se NE upisuje u gotovina — to je STARI novac (već primljen
    // prije ovog unosa, negdje van sistema), ne novac primljen danas. U blagajnu bi ušao samo
    // budući iznos naplaćen kroz POST /:id/naplati-dug, kad se stvarno desi.

    await client.query('COMMIT');
    res.status(201).json({ ...h.rows[0], duguje: +(ukupanIznos - iznosVecPlaceno).toFixed(2) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
