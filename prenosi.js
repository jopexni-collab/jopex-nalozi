const express = require('express');
const router = express.Router();
const pool = require('./db');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Prenos robe između PJ je administrativna operacija — samo admin.
router.use((req, res, next) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može prebacivati robu između prodajnih objekata.' });
  next();
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
async function prebaciStavku(client, { roba, izObjekta, uObjekat, kolicina, korisnik }) {
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

  const cijenaIzvor = izvorRes.rows[0].cijena;
  await client.query(
    `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (roba_id, objekt_id) DO UPDATE SET stanje = roba_pj.stanje + $4, azurirano = now()`,
    [roba.id, uObjekat.id, cijenaIzvor, kol]
  );

  const log = await client.query(
    `INSERT INTO prenosi_robe
       (roba_id, sifra, naziv, iz_objekta_id, iz_objekta_naziv, u_objekat_id, u_objekat_naziv,
        kolicina, jed_mjera, korisnik_id, korisnik_ime)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [roba.id, roba.sifra, roba.naziv, izObjekta.id, izObjekta.naziv, uObjekat.id, uObjekat.naziv,
     kol, roba.jed_mjera, korisnik.id, korisnik.ime_prezime]
  );
  return log.rows[0];
}

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
        await prebaciStavku(client, { roba: robaRes.rows[0], izObjekta, uObjekat, kolicina, korisnik: user });
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
