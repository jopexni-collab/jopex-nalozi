const express = require('express');
const router = express.Router();
const pool = require('./db');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Prenos robe između PJ je administrativna operacija — samo admin.
// Prenos robe smije admin I svako ko ima pristup modulu Roba i magacini — jer je to
// dio svakodnevnog rada sa lagerom, ne administrativna radnja. Prenos ne mijenja ukupno
// stanje firme (roba samo prelazi iz jednog objekta u drugi) i svaki se bilježi u
// prenosi_robe sa datumom i imenom korisnika, pa je uvijek jasno ko je sta radio.
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_roba_magacin) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za prebacivanje robe između objekata.' });
});

/* GET /api/prenosi/dokument/:broj — sve stavke jedne prenosnice, za stampu.
   Grupisano po broju, pa se vise artikala prebacenih odjednom prikazuje kao JEDAN
   dokument (isto kao otpremnica). */
router.get('/dokument/:broj', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM prenosi_robe WHERE prenosnica_broj = $1 ORDER BY id`, [req.params.broj]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Prenosnica nije pronađena.' });
    const prvi = r.rows[0];
    res.json({
      broj: prvi.prenosnica_broj,
      datum: prvi.kreiran,
      iz_objekta: prvi.iz_objekta_naziv,
      u_objekat: prvi.u_objekat_naziv,
      kreirao: prvi.korisnik_ime,
      napomena: prvi.napomena,
      javni_token: prvi.javni_token,
      stavke: r.rows.map(x => ({
        sifra: x.sifra, naziv: x.naziv,
        kolicina: +parseFloat(x.kolicina).toFixed(3), jed_mjera: x.jed_mjera,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prenosi?limit=50 - istorija prenosa (za pregled/audit)
router.get('/', async (req, res) => {
  try {
    const lim = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await pool.query(`SELECT * FROM prenosi_robe ORDER BY kreiran DESC LIMIT $1`, [lim]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Zajednička logika: prebacuje `kolicina` artikla `sifra_ili_id` iz jednog PJ u drugi,
// unutar postojeće (spoljne) transakcije. Koristi je i ručni unos (POST /) i XLSX uvoz.
// Cijena OSTAJE PO ODREDIŠNOM PJ (ne mijenja se automatski) — ako artikal još nema
// cijenu/red u odredišnom PJ, preuzima se cijena iz izvornog PJ kao početna vrijednost.
/* Broj prenosnice — PRE-2026-000001. Uzima se UNUTAR transakcije sa zakljucavanjem reda,
   pa dva istovremena prenosa ne mogu dobiti isti broj. */
async function sljedeciBrojPrenosnice(client) {
  const god = new Date().getFullYear();
  await client.query(
    `INSERT INTO prenosnica_brojac (godina, zadnji) VALUES ($1,0) ON CONFLICT (godina) DO NOTHING`, [god]
  );
  const r = await client.query(
    `UPDATE prenosnica_brojac SET zadnji = zadnji + 1 WHERE godina = $1 RETURNING zadnji`, [god]
  );
  return `PRE-${god}-${String(r.rows[0].zadnji).padStart(6, '0')}`;
}

async function prebaciStavku(client, { roba, izObjekta, uObjekat, kolicina, korisnik, cijena_iz_izvora, prenosnica_broj, javni_token, napomena }) {
  const kol = parseFloat(kolicina);
  if (!kol || kol <= 0) throw Object.assign(new Error('Neispravna količina.'), { status: 400 });

  const izvorRes = await client.query(
    'SELECT * FROM roba_pj WHERE roba_id=$1 AND objekt_id=$2 FOR UPDATE',
    [roba.id, izObjekta.id]
  );
  if (!izvorRes.rows.length || parseFloat(izvorRes.rows[0].stanje) < kol) {
    const raspolozivo = izvorRes.rows.length ? izvorRes.rows[0].stanje : 0;
    throw Object.assign(
      new Error(`Nedovoljno stanje za "${roba.naziv}" u "${izObjekta.naziv}" (raspoloživo: ${raspolozivo} ${roba.jed_mjera}).`),
      { status: 400 }
    );
  }

  await client.query(
    'UPDATE roba_pj SET stanje = stanje - $1, azurirano = now() WHERE roba_id=$2 AND objekt_id=$3',
    [kol, roba.id, izObjekta.id]
  );

  /* CIJENA NA ODREDISTU
     Ako artikal VEC postoji u odredisnom objektu, on tamo ima svoju cijenu. Podrazumijevano
     se ta cijena ZADRZAVA (prenos je kretanje robe, ne promjena cjenovnika). Ako korisnik
     izricito trazi (cijena_iz_izvora), preuzima se cijena iz izvornog objekta.
     Kad artikla u odredistu jos NEMA, cijena se uvijek uzima iz izvora — nema alternative. */
  const cijenaIzvor = izvorRes.rows[0].cijena;
  const postojiUOdredistu = await client.query(
    'SELECT cijena FROM roba_pj WHERE roba_id=$1 AND objekt_id=$2', [roba.id, uObjekat.id]
  );
  const imaOdrediste = postojiUOdredistu.rows.length > 0;
  const cijenaOdrediste = imaOdrediste ? postojiUOdredistu.rows[0].cijena : null;

  if (!imaOdrediste) {
    await client.query(
      `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje) VALUES ($1,$2,$3,$4)`,
      [roba.id, uObjekat.id, cijenaIzvor, kol]
    );
  } else if (cijena_iz_izvora) {
    await client.query(
      `UPDATE roba_pj SET stanje = stanje + $1, cijena = $2, azurirano = now()
       WHERE roba_id=$3 AND objekt_id=$4`,
      [kol, cijenaIzvor, roba.id, uObjekat.id]
    );
  } else {
    await client.query(
      `UPDATE roba_pj SET stanje = stanje + $1, azurirano = now()
       WHERE roba_id=$2 AND objekt_id=$3`,
      [kol, roba.id, uObjekat.id]
    );
  }

  const log = await client.query(
    `INSERT INTO prenosi_robe
       (roba_id, sifra, naziv, iz_objekta_id, iz_objekta_naziv, u_objekat_id, u_objekat_naziv,
        kolicina, jed_mjera, korisnik_id, korisnik_ime, prenosnica_broj, javni_token, napomena)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [roba.id, roba.sifra, roba.naziv, izObjekta.id, izObjekta.naziv, uObjekat.id, uObjekat.naziv,
     kol, roba.jed_mjera, korisnik.id, korisnik.ime_prezime,
     prenosnica_broj || null, javni_token || null, napomena || null]
  );
  return log.rows[0];
}

// POST /api/prenosi/bulk - RUČNI unos, VIŠE stavki odjednom (jedna "korpa" prenosa).
// body: { iz_objekta_id, u_objekat_id, stavke: [{ roba_id, kolicina }, ...] }
// Sve u JEDNOJ transakciji — ako bilo koja stavka ne prođe (npr. nedovoljno stanje),
// ništa se ne upisuje (all-or-nothing), da se ne desi da pola liste prođe a pola ne.

/* POST /api/prenosi/provjeri-cijene — PRIJE prenosa vraca spisak artikala kod kojih se
   cijena u izvoru i odredistu razlikuju. Frontend na osnovu toga pita korisnika sta zeli.
   Ne mijenja NISTA u bazi — samo cita. */
router.post('/provjeri-cijene', async (req, res) => {
  const { iz_objekta_id, u_objekat_id, stavke } = req.body || {};
  if (!iz_objekta_id || !u_objekat_id || !Array.isArray(stavke) || !stavke.length)
    return res.json({ razlike: [] });
  try {
    const ids = stavke.map(s => parseInt(s.roba_id)).filter(Boolean);
    if (!ids.length) return res.json({ razlike: [] });
    const r = await pool.query(
      `SELECT r.id, r.sifra, r.naziv, r.jed_mjera,
              iz.cijena AS cijena_izvor,
              od.cijena AS cijena_odrediste
       FROM roba r
       JOIN roba_pj iz ON iz.roba_id = r.id AND iz.objekt_id = $2
       JOIN roba_pj od ON od.roba_id = r.id AND od.objekt_id = $3
       WHERE r.id = ANY($1::int[])
         AND ABS(COALESCE(iz.cijena,0) - COALESCE(od.cijena,0)) > 0.005`,
      [ids, iz_objekta_id, u_objekat_id]
    );
    res.json({
      razlike: r.rows.map(x => ({
        roba_id: x.id, sifra: x.sifra, naziv: x.naziv, jed_mjera: x.jed_mjera,
        cijena_izvor: +parseFloat(x.cijena_izvor).toFixed(2),
        cijena_odrediste: +parseFloat(x.cijena_odrediste).toFixed(2),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk', async (req, res) => {
  const user = req.session.user;
  const { iz_objekta_id, u_objekat_id, stavke, cijena_iz_izvora } = req.body;

  if (!iz_objekta_id || !u_objekat_id)
    return res.status(400).json({ error: 'Nedostaju izvorni i odredišni objekat.' });
  if (String(iz_objekta_id) === String(u_objekat_id))
    return res.status(400).json({ error: 'Izvorni i odredišni objekat moraju biti različiti.' });
  if (!Array.isArray(stavke) || !stavke.length)
    return res.status(400).json({ error: 'Lista za prenos je prazna.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Sve stavke jednog prebacivanja dobijaju ISTI broj — to je jedna prenosnica.
    const brojPrenosnice = await sljedeciBrojPrenosnice(client);
    const tokenPrenosnice = crypto.randomBytes(16).toString('hex');

    const objekti = await client.query(
      'SELECT * FROM prodajni_objekti WHERE id = ANY($1::int[])', [[iz_objekta_id, u_objekat_id]]
    );
    const izObjekta = objekti.rows.find(o => String(o.id) === String(iz_objekta_id));
    const uObjekat = objekti.rows.find(o => String(o.id) === String(u_objekat_id));
    if (!izObjekta || !uObjekat) throw Object.assign(new Error('Prodajni objekat nije pronađen.'), { status: 404 });

    const zapisi = [];
    for (const s of stavke) {
      const robaRes = await client.query('SELECT * FROM roba WHERE id=$1', [s.roba_id]);
      if (!robaRes.rows.length)
        throw Object.assign(new Error(`Artikal (id ${s.roba_id}) nije pronađen.`), { status: 404 });
      const zapis = await prebaciStavku(client, {
        roba: robaRes.rows[0], izObjekta, uObjekat, kolicina: s.kolicina, korisnik: user,
        cijena_iz_izvora: cijena_iz_izvora === true,
        prenosnica_broj: brojPrenosnice, javni_token: tokenPrenosnice,
        napomena: req.body.napomena || null,
      });
      zapisi.push(zapis);
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, prebaceno: zapisi.length, stavke: zapisi,
      prenosnica_broj: brojPrenosnice, javni_token: tokenPrenosnice });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/prenosi - RUČNI unos, jedna stavka.
// body: { roba_id, iz_objekta_id, u_objekat_id, kolicina }
router.post('/', async (req, res) => {
  const user = req.session.user;
  const { roba_id, iz_objekta_id, u_objekat_id, kolicina } = req.body;

  if (!roba_id || !iz_objekta_id || !u_objekat_id)
    return res.status(400).json({ error: 'Nedostaju podaci (artikal, izvorni i odredišni objekat).' });
  if (String(iz_objekta_id) === String(u_objekat_id))
    return res.status(400).json({ error: 'Izvorni i odredišni objekat moraju biti različiti.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const robaRes = await client.query('SELECT * FROM roba WHERE id=$1', [roba_id]);
    if (!robaRes.rows.length) throw Object.assign(new Error('Artikal nije pronađen.'), { status: 404 });

    const objekti = await client.query(
      'SELECT * FROM prodajni_objekti WHERE id = ANY($1::int[])', [[iz_objekta_id, u_objekat_id]]
    );
    const izObjekta = objekti.rows.find(o => String(o.id) === String(iz_objekta_id));
    const uObjekat = objekti.rows.find(o => String(o.id) === String(u_objekat_id));
    if (!izObjekta || !uObjekat) throw Object.assign(new Error('Prodajni objekat nije pronađen.'), { status: 404 });

    const zapis = await prebaciStavku(client, { roba: robaRes.rows[0], izObjekta, uObjekat, kolicina, korisnik: user });

    await client.query('COMMIT');
    res.status(201).json(zapis);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── XLSX UVOZ PRENOSNICE (bulk, dvokoraki obrazac kao i uvoz robe) ───────────
const normKey = s => String(s).toLowerCase().trim()
  .replace(/č/g, 'c').replace(/ć/g, 'c').replace(/š/g, 's').replace(/ž/g, 'z').replace(/đ/g, 'dj');

const NAGADJANJE = {
  sifra:    ['sifra robe', 'sifra', 'šifra', 'sifra artikla', 'kod'],
  kolicina: ['kolicina', 'količina', 'kol', 'qty', 'stanje/m2/m3/kom', 'stanje'],
};

function nagadjajMapiranje(header) {
  const predlog = {};
  const zauzete = new Set();
  for (const field of Object.keys(NAGADJANJE)) {
    const found = header.find(h => !zauzete.has(h) && NAGADJANJE[field].some(a => normKey(a) === normKey(h)));
    if (found) { predlog[field] = found; zauzete.add(found); }
  }
  for (const field of Object.keys(NAGADJANJE)) {
    if (predlog[field]) continue;
    const found = header.find(h => !zauzete.has(h) && NAGADJANJE[field].some(a => normKey(h).includes(normKey(a))));
    if (found) { predlog[field] = found; zauzete.add(found); }
  }
  return predlog;
}

function citajRadniList(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

// Isti parser kao u roba.js — hvata i evropski format ("1.234,56") ispravno.
function parsirajBroj(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// POST /api/prenosi/import/pregled - vraća zaglavlja + uzorak + predlog mapiranja (ne piše u bazu)
router.post('/import/pregled', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fajl nije priložen.' });
  try {
    const rows = citajRadniList(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: 'Fajl je prazan.' });
    const header = Object.keys(rows[0]);
    const predlog = nagadjajMapiranje(header);
    res.json({ header, uzorak: rows.slice(0, 5), predlog, ukupno_redova: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri čitanju fajla: ' + err.message });
  }
});

// POST /api/prenosi/import - stvarni uvoz. Jedan izvorni i jedan odredišni PJ važe za CIJELI
// fajl (prenosnica je uvijek između dvije tačke) — samo redovi (šifra, količina) dolaze iz XLSX-a.
// multipart/form-data: file, iz_objekta_id, u_objekat_id, mapping (JSON: {sifra, kolicina})
router.post('/import', upload.single('file'), async (req, res) => {
  const user = req.session.user;
  if (!req.file) return res.status(400).json({ error: 'Fajl nije priložen.' });

  const { iz_objekta_id, u_objekat_id } = req.body;
  if (!iz_objekta_id || !u_objekat_id)
    return res.status(400).json({ error: 'Izaberite izvorni i odredišni prodajni objekat.' });
  if (String(iz_objekta_id) === String(u_objekat_id))
    return res.status(400).json({ error: 'Izvorni i odredišni objekat moraju biti različiti.' });

  let mapping;
  try { mapping = JSON.parse(req.body.mapping || '{}'); }
  catch { return res.status(400).json({ error: 'Neispravno mapiranje kolona.' }); }
  if (!mapping.sifra || !mapping.kolicina)
    return res.status(400).json({ error: 'Morate mapirati kolone "Šifra" i "Količina".' });

  try {
    const rows = citajRadniList(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: 'Fajl je prazan.' });

    const objRes = await pool.query(
      'SELECT * FROM prodajni_objekti WHERE id = ANY($1::int[])', [[iz_objekta_id, u_objekat_id]]
    );
    const izObjekta = objRes.rows.find(o => String(o.id) === String(iz_objekta_id));
    const uObjekat = objRes.rows.find(o => String(o.id) === String(u_objekat_id));
    if (!izObjekta || !uObjekat) return res.status(404).json({ error: 'Prodajni objekat nije pronađen.' });

    let uspjesno = 0, preskoceno = 0;
    const greske = [];

    for (const row of rows) {
      const sifra = String(row[mapping.sifra] ?? '').trim();
      const kolicina = parsirajBroj(row[mapping.kolicina]);
      if (!sifra || !kolicina || kolicina <= 0) { preskoceno++; continue; }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const robaRes = await client.query('SELECT * FROM roba WHERE sifra=$1', [sifra]);
        if (!robaRes.rows.length) {
          throw Object.assign(new Error(`Šifra "${sifra}" ne postoji u šifrarniku.`), { status: 400 });
        }
        await prebaciStavku(client, { roba: robaRes.rows[0], izObjekta, uObjekat, kolicina,
          korisnik: user, cijena_iz_izvora: req.body?.cijena_iz_izvora === 'true' || req.body?.cijena_iz_izvora === true });
        await client.query('COMMIT');
        uspjesno++;
      } catch (err) {
        await client.query('ROLLBACK');
        preskoceno++;
        greske.push(`${sifra}: ${err.message}`);
      } finally {
        client.release();
      }
    }

    res.json({ ok: true, uspjesno, preskoceno, ukupno_redova: rows.length, greske: greske.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri uvozu: ' + err.message });
  }
});

module.exports = router;
