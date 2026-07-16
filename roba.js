const express = require('express');
const router = express.Router();
const pool = require('./db');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true (dozvola iz korisnici.html).
// Primjenjuje se samo na GET rute za pretragu/pregled robe (POST/PATCH/DELETE/import su već
// ograničeni striktnije na rola==='admin', pa im ovo ne treba dodatno).
function zahtijevaProdaju(req, res, next) {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
}

// GET /api/roba?q=pretraga&limit=30 - pretraga po šifri ili nazivu
router.get('/', zahtijevaProdaju, async (req, res) => {
  try {
    const { q, limit } = req.query;
    const lim = Math.min(parseInt(limit) || 30, 100);
    if (!q || !q.trim()) {
      const r = await pool.query(
        'SELECT * FROM roba WHERE aktivan=true ORDER BY naziv LIMIT $1', [lim]
      );
      return res.json(r.rows);
    }
    const term = q.trim();
    const r = await pool.query(
      `SELECT * FROM roba
       WHERE aktivan=true AND (sifra ILIKE $1 OR naziv ILIKE $2)
       ORDER BY (sifra ILIKE $1) DESC, naziv
       LIMIT $3`,
      [`${term}%`, `%${term}%`, lim]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roba/:id
router.get('/:id', zahtijevaProdaju, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM roba WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba - ručno dodavanje artikla
router.post('/', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može dodavati/mijenjati šifrarnik.' });
  try {
    const { sifra, naziv, jed_mjera, cijena, stanje } = req.body;
    if (!sifra || !naziv) return res.status(400).json({ error: 'Šifra i naziv su obavezni.' });
    const r = await pool.query(
      `INSERT INTO roba (sifra, naziv, jed_mjera, cijena, stanje, izvor_uvoza)
       VALUES ($1,$2,$3,$4,$5,'ručno')
       ON CONFLICT (sifra) DO UPDATE SET naziv=$2, jed_mjera=$3, cijena=$4, stanje=$5, azurirano=now()
       RETURNING *`,
      [sifra, naziv, jed_mjera || 'kom', cijena || 0, stanje || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/roba/bulk-jedinica - "blic izbor": grupno postavljanje jed_mjere za više artikala
// odjednom (jednim dodirom), da se ne mora ići artikal po artikal nakon uvoza. Samo admin.
// body: { ids: [1,2,3], jed_mjera: 'kom'|'m2'|'m3' }
router.patch('/bulk-jedinica', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može mijenjati šifrarnik.' });
  try {
    const { ids, jed_mjera } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Nema izabranih artikala.' });
    if (!['kom', 'm2', 'm3'].includes(jed_mjera)) return res.status(400).json({ error: 'Neispravna jedinica mjere.' });
    const r = await pool.query(
      `UPDATE roba SET jed_mjera=$1, azurirano=now() WHERE id = ANY($2::int[]) RETURNING id`,
      [jed_mjera, ids]
    );
    res.json({ ok: true, izmijenjeno: r.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/roba/:id - izmjena (cijena, stanje, naziv, aktivan) — samo admin
router.patch('/:id', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može mijenjati šifrarnik.' });
  try {
    const ALLOWED = ['naziv', 'jed_mjera', 'cijena', 'stanje', 'aktivan'];
    const sets = [], vals = [];
    let i = 1;
    for (const k of ALLOWED) {
      if (k in req.body) { sets.push(`${k}=$${i++}`); vals.push(req.body[k]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nema polja.' });
    sets.push(`azurirano=now()`);
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE roba SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/roba/:id - samo admin
router.delete('/:id', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    await pool.query('DELETE FROM roba WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── XLSX IMPORT (Bluesoft izvoz ili interni cjenovnik) ───────────────
// Dvokoračni tok jer stvarni exporti (npr. Bluesoft) često imaju nestandardna
// ili zbunjujuća zaglavlja (npr. kolona "code" može biti grupa/tip robe, a ne
// jedinstvena šifra; kolona "VAL" cijena; "opis" izračunata vrijednost itd).
// Zato se kolone NE nagađaju naslijepo — admin ih potvrdi na osnovu stvarnog
// zaglavlja i par primjera redova.

const normKey = s => String(s).toLowerCase().trim()
  .replace(/č/g, 'c').replace(/ć/g, 'c').replace(/š/g, 's').replace(/ž/g, 'z').replace(/đ/g, 'dj');

const NAGADJANJE = {
  sifra:     ['sifra robe', 'sifra', 'šifra', 'sifra artikla', 'šifra artikla', 'id', 'kod'],
  naziv:     ['naziv', 'naziv artikla', 'name', 'artikal'],
  jed_mjera: ['jm', 'j.m.', 'jed mjera', 'jed. mjere', 'jedinica mjere', 'mjera'],
  cijena:    ['unit price', 'jedinicna cijena', 'cijena', 'cena', 'mpc', 'maloprodajna cijena', 'prodajna cijena', 'price', 'val'],
  stanje:    ['stanje/m2/m3/kom', 'stanje', 'zaliha', 'kolicina', 'količina', 'kol', 'qty', 'raspolozivo'],
};

// Dvoprolazno prepoznavanje: prvo TAČNO poklapanje (cijeli naziv kolone), pa tek onda
// djelimično (kolona SADRŽI alias) za kolone koje ostanu nespojene — i to samo ako ta
// kolona već nije "uzeta" od strane nekog drugog polja tačnim poklapanjem. Ovo sprječava
// sudare poput toga da "unit" (dio alias-a za jed. mjere) slučajno pogodi "Unit Price".
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

// POST /api/roba/import/pregled - vraća zaglavlja + par primjera redova + predloženo mapiranje
// (ništa se ne piše u bazu). multipart/form-data, polje "file".
router.post('/import/pregled', upload.single('file'), async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može uvoziti robu.' });
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

// POST /api/roba/import - stvarni uvoz, KORISTI mapiranje koje je admin potvrdio.
// multipart/form-data: polje "file" + polje "mapping" (JSON string), npr.
// {"sifra":"8515","naziv":"naziv","cijena":"VAL","stanje":"stanje","jed_mjera":""}
// + polje "jed_mjera_default" (koristi se ako mapping.jed_mjera nije zadan).
router.post('/import', upload.single('file'), async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može uvoziti robu.' });
  if (!req.file) return res.status(400).json({ error: 'Fajl nije priložen.' });

  let mapping;
  try { mapping = JSON.parse(req.body.mapping || '{}'); }
  catch { return res.status(400).json({ error: 'Neispravno mapiranje kolona.' }); }

  if (!mapping.sifra || !mapping.naziv) {
    return res.status(400).json({ error: 'Morate mapirati bar kolone "Šifra" i "Naziv".' });
  }

  try {
    const rows = citajRadniList(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: 'Fajl je prazan.' });

    const izvor = req.body.izvor === 'interni' ? 'interni' : 'bluesoft';
    const jmDefault = (req.body.jed_mjera_default || 'kom').trim() || 'kom';
    let uneseno = 0, azurirano = 0, preskoceno = 0;

    await pool.query('BEGIN');
    try {
      for (const row of rows) {
        const sifra = String(row[mapping.sifra] ?? '').trim();
        const naziv = String(row[mapping.naziv] ?? '').trim();
        if (!sifra || !naziv) { preskoceno++; continue; }

        const cijenaRaw = mapping.cijena ? row[mapping.cijena] : 0;
        const stanjeRaw = mapping.stanje ? row[mapping.stanje] : 0;
        const cijena = parseFloat(String(cijenaRaw).replace(',', '.')) || 0;
        const stanje = parseFloat(String(stanjeRaw).replace(',', '.')) || 0;

        // Ako fajl nema posebnu kolonu za jedinicu mjere, pogađamo po obliku broja u
        // koloni stanja: cijeli broj (npr. 45) -> najvjerovatnije "kom", decimalan
        // (npr. 6,20) -> najvjerovatnije "m2". Ovo je samo POLAZNA pretpostavka —
        // ne mora biti tačna za svaki artikal. Ako trgovac pri prodaji izabere
        // drugačiju jedinicu, sistem to automatski prijavljuje kao odstupanje
        // (vidi otpremnice.js) pa se greške brzo uočavaju naknadno, bez potrebe
        // da se pri svakom uvozu ide artikal po artikal.
        const jed_mjera = mapping.jed_mjera
          ? (String(row[mapping.jed_mjera] ?? '').trim() || jmDefault)
          : (Number.isInteger(stanje) && stanje !== 0 ? 'kom' : 'm2');

        const r = await pool.query(
          `INSERT INTO roba (sifra, naziv, jed_mjera, cijena, stanje, izvor_uvoza)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (sifra) DO UPDATE
             SET naziv=$2, jed_mjera=$3, cijena=$4, stanje=$5, izvor_uvoza=$6, azurirano=now()
           RETURNING (xmax = 0) AS inserted`,
          [sifra, naziv, jed_mjera, cijena, stanje, izvor]
        );
        if (r.rows[0].inserted) uneseno++; else azurirano++;
      }
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    res.json({ ok: true, uneseno, azurirano, preskoceno, ukupno_redova: rows.length, kolone: mapping });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri uvozu: ' + err.message });
  }
});

module.exports = router;
