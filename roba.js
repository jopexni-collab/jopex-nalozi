const express = require('express');
const router = express.Router();
const pool = require('./db');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true (dozvola iz korisnici.html).
function zahtijevaProdaju(req, res, next) {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
}

// Svaki prodajni objekat (PJ) ima svoju cijenu i stanje za isti artikal (tabela roba_pj).
// Zato skoro sve rute ovdje zahtijevaju ?objekt_id= (ili objekt_id u body-ju) — bez toga
// ne znamo koju cijenu/stanje da vratimo/mijenjamo.
function trebaObjekat(id) {
  const n = parseInt(id);
  return n > 0 ? n : null;
}

// GET /api/roba?q=pretraga&limit=30&objekt_id=1
// objekt_id je OPCION: ako je dat, vraća i cijenu/stanje ZA TAJ PJ (koristi prodajni ekran);
// ako nije dat, vraća samo šifrarnik bez cijene/stanja (koristi "blic izbor" jedinice mjere,
// jer jed_mjera nije po lokaciji nego zajednička za sve PJ).
router.get('/', zahtijevaProdaju, async (req, res) => {
  try {
    const { q, limit } = req.query;
    const objektId = trebaObjekat(req.query.objekt_id);
    const lim = Math.min(parseInt(limit) || 30, 100);
    const term = (q || '').trim();

    if (objektId) {
      if (!term) {
        const r = await pool.query(
          `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.aktivan, rp.cijena, rp.stanje
           FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
           WHERE r.aktivan=true ORDER BY r.naziv LIMIT $2`,
          [objektId, lim]
        );
        return res.json(r.rows);
      }
      const r = await pool.query(
        `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.aktivan, rp.cijena, rp.stanje
         FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
         WHERE r.aktivan=true AND (r.sifra ILIKE $2 OR r.naziv ILIKE $3)
         ORDER BY (r.sifra ILIKE $2) DESC, r.naziv
         LIMIT $4`,
        [objektId, `${term}%`, `%${term}%`, lim]
      );
      return res.json(r.rows);
    }

    // Bez objekt_id — samo šifrarnik (npr. za blic izbor jedinice mjere), bez cijene/stanja.
    if (!term) {
      const r = await pool.query(
        'SELECT id, sifra, naziv, jed_mjera, aktivan FROM roba WHERE aktivan=true ORDER BY naziv LIMIT $1', [lim]
      );
      return res.json(r.rows);
    }
    const r = await pool.query(
      `SELECT id, sifra, naziv, jed_mjera, aktivan FROM roba
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

// GET /api/roba/lager?objekt_id=X - kompletna lager lista za PJ (šifra/naziv/JM/cijena/stanje/ukupno) — admin
// MORA biti prije "/:id" rute ispod — inače Express tumači "lager" kao vrijednost za :id.
router.get('/lager', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može pregledati kompletan lager.' });
  const objektId = trebaObjekat(req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });
  try {
    const r = await pool.query(
      `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, rp.cijena, rp.stanje,
              (rp.cijena * rp.stanje) AS ukupno
       FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
       WHERE r.aktivan=true
       ORDER BY r.naziv`,
      [objektId]
    );
    const totalVrijednost = r.rows.reduce((s, row) => s + parseFloat(row.ukupno || 0), 0);
    res.json({ stavke: r.rows, total_vrijednost: +totalVrijednost.toFixed(2), broj_artikala: r.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roba/:id?objekt_id=1
router.get('/:id', zahtijevaProdaju, async (req, res) => {
  try {
    const objektId = trebaObjekat(req.query.objekt_id);
    if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });
    const r = await pool.query(
      `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.aktivan, rp.cijena, rp.stanje
       FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
       WHERE r.id=$2`,
      [objektId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno (ili nema podataka za ovaj PJ).' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba - ručno dodavanje artikla ZA ODREĐENI PJ (cijena/stanje idu u roba_pj)
router.post('/', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može dodavati/mijenjati šifrarnik.' });
  try {
    const { sifra, naziv, jed_mjera, cijena, stanje, objekt_id } = req.body;
    const objektId = trebaObjekat(objekt_id);
    if (!sifra || !naziv) return res.status(400).json({ error: 'Šifra i naziv su obavezni.' });
    if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });

    const roba = await pool.query(
      `INSERT INTO roba (sifra, naziv, jed_mjera, izvor_uvoza)
       VALUES ($1,$2,$3,'ručno')
       ON CONFLICT (sifra) DO UPDATE SET naziv=$2, jed_mjera=$3, azurirano=now()
       RETURNING *`,
      [sifra, naziv, jed_mjera || 'kom']
    );
    const robaId = roba.rows[0].id;
    const rp = await pool.query(
      `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (roba_id, objekt_id) DO UPDATE SET cijena=$3, stanje=$4, azurirano=now()
       RETURNING *`,
      [robaId, objektId, cijena || 0, stanje || 0]
    );
    res.status(201).json({ ...roba.rows[0], cijena: rp.rows[0].cijena, stanje: rp.rows[0].stanje });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/roba/bulk-jedinica - "blic izbor": grupno postavljanje jed_mjere (zajedničko za sve PJ,
// jed_mjera je osobina artikla u šifrarniku, ne po lokaciji). Samo admin.
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

// PATCH /api/roba/:id - izmjena. naziv/jed_mjera/aktivan su ZAJEDNIČKI za sve PJ (mijenjaju `roba`),
// cijena/stanje su PO PJ (mijenjaju `roba_pj`, zahtijeva objekt_id). Samo admin.
router.patch('/:id', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može mijenjati šifrarnik.' });
  try {
    const { naziv, jed_mjera, aktivan, cijena, stanje, objekt_id } = req.body;
    const ZAJEDNICKA = { naziv, jed_mjera, aktivan };
    const sets = [], vals = [];
    let i = 1;
    for (const k of Object.keys(ZAJEDNICKA)) {
      if (ZAJEDNICKA[k] !== undefined) { sets.push(`${k}=$${i++}`); vals.push(ZAJEDNICKA[k]); }
    }
    let robaRow = null;
    if (sets.length) {
      sets.push('azurirano=now()');
      vals.push(req.params.id);
      const r = await pool.query(`UPDATE roba SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
      if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
      robaRow = r.rows[0];
    }

    let pjRow = null;
    if (cijena !== undefined || stanje !== undefined) {
      const objektId = trebaObjekat(objekt_id);
      if (!objektId) return res.status(400).json({ error: 'Za izmjenu cijene/stanja potreban je objekt_id.' });
      const rp = await pool.query(
        `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje)
         VALUES ($1,$2,COALESCE($3,0),COALESCE($4,0))
         ON CONFLICT (roba_id, objekt_id) DO UPDATE SET
           cijena=COALESCE($3, roba_pj.cijena), stanje=COALESCE($4, roba_pj.stanje), azurirano=now()
         RETURNING *`,
        [req.params.id, objektId, cijena, stanje]
      );
      pjRow = rp.rows[0];
    }

    if (!robaRow && !pjRow) return res.status(400).json({ error: 'Nema polja.' });
    if (!robaRow) {
      const r = await pool.query('SELECT * FROM roba WHERE id=$1', [req.params.id]);
      robaRow = r.rows[0];
    }
    res.json({ ...robaRow, ...(pjRow ? { cijena: pjRow.cijena, stanje: pjRow.stanje } : {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/roba/:id - samo admin (briše artikal iz šifrarnika za SVE PJ, jer je roba_pj CASCADE)
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
// ili zbunjujuća zaglavlja. Zato se kolone NE nagađaju naslijepo — admin ih
// potvrdi na osnovu stvarnog zaglavlja i par primjera redova.

const normKey = s => String(s).toLowerCase().trim()
  .replace(/č/g, 'c').replace(/ć/g, 'c').replace(/š/g, 's').replace(/ž/g, 'z').replace(/đ/g, 'dj');

const NAGADJANJE = {
  sifra:     ['sifra robe', 'sifra', 'šifra', 'sifra artikla', 'šifra artikla', 'id', 'kod'],
  naziv:     ['naziv', 'naziv artikla', 'name', 'artikal'],
  jed_mjera: ['jm', 'j.m.', 'jed mjera', 'jed. mjere', 'jedinica mjere', 'mjera'],
  cijena:    ['unit price', 'jedinicna cijena', 'cijena', 'cena', 'mpc', 'maloprodajna cijena', 'prodajna cijena', 'price', 'val'],
  stanje:    ['stanje/m2/m3/kom', 'stanje', 'zaliha', 'kolicina', 'količina', 'kol', 'qty', 'raspolozivo'],
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
// multipart/form-data: polje "file" + "mapping" (JSON) + "objekt_id" (za koji PJ je ovaj lager) +
// "jed_mjera_default" + "nacin" ('zamjena' | 'nabavka', podrazumijevano 'nabavka') +
// "azuriraj_cijenu" ('true'/'false' — samo za 'nabavka' režim).
//
// ZAMJENA (kompletan lager): stanje SVIH postojećih artikala za ovaj PJ se prvo nulira,
// pa se iz fajla upisuje stanje I cijena tačno kako piše (fajl je nova, potpuna istina za PJ).
//
// NABAVKA (nova isporuka): stanje iz fajla se DODAJE na postojeće (ne briše se ništa).
// Cijena OSTAJE STARA po difoltu — ako fajl ima drugačiju cijenu za neki artikal, to se
// PRIJAVLJUJE (broj artikala + lista) admin-u, a da li će se stvarno primijeniti zavisi
// od "azuriraj_cijenu" (ako je true, primjenjuju se nove cijene za baš te artikle; ako je
// false, samo se prijavljuje razlika, cijena ostaje stara).
router.post('/import', upload.single('file'), async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može uvoziti robu.' });
  if (!req.file) return res.status(400).json({ error: 'Fajl nije priložen.' });

  const objektId = trebaObjekat(req.body.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Morate izabrati prodajni objekat za koji uvozite lager.' });

  const nacin = req.body.nacin === 'zamjena' ? 'zamjena' : 'nabavka';
  const azurirajCijenu = req.body.azuriraj_cijenu === 'true';

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
    const cijenaRazlike = []; // { sifra, naziv, stara, nova } — samo za 'nabavka'

    await pool.query('BEGIN');
    try {
      // ZAMJENA: prvo nuliraj stanje SVIH postojećih artikala za ovaj PJ — fajl koji slijedi
      // je nova kompletna istina. Cijena ostaje netaknuta ovim korakom (postavlja je fajl niže).
      if (nacin === 'zamjena') {
        await pool.query('UPDATE roba_pj SET stanje=0, azurirano=now() WHERE objekt_id=$1', [objektId]);
      }

      for (const row of rows) {
        const sifra = String(row[mapping.sifra] ?? '').trim();
        const naziv = String(row[mapping.naziv] ?? '').trim();
        if (!sifra || !naziv) { preskoceno++; continue; }

        const cijenaRaw = mapping.cijena ? row[mapping.cijena] : 0;
        const stanjeRaw = mapping.stanje ? row[mapping.stanje] : 0;
        const cijenaFajl = parseFloat(String(cijenaRaw).replace(',', '.')) || 0;
        const stanjeFajl = parseFloat(String(stanjeRaw).replace(',', '.')) || 0;

        // Ako fajl nema posebnu kolonu za jedinicu mjere, pogađamo po obliku broja u
        // koloni stanja: cijeli broj -> "kom", decimalan -> "m2". Samo POLAZNA pretpostavka —
        // ako trgovac pri prodaji izabere drugačiju jedinicu, sistem to automatski
        // prijavljuje kao odstupanje (vidi otpremnice.js).
        const jed_mjera = mapping.jed_mjera
          ? (String(row[mapping.jed_mjera] ?? '').trim() || jmDefault)
          : (Number.isInteger(stanjeFajl) && stanjeFajl !== 0 ? 'kom' : 'm2');

        // 1) Šifrarnik (zajednički za sve PJ) — upsert po šifri
        const robaRes = await pool.query(
          `INSERT INTO roba (sifra, naziv, jed_mjera, izvor_uvoza)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (sifra) DO UPDATE SET naziv=$2, jed_mjera=$3, izvor_uvoza=$4, azurirano=now()
           RETURNING id, (xmax = 0) AS inserted`,
          [sifra, naziv, jed_mjera, izvor]
        );
        const robaId = robaRes.rows[0].id;

        // 2) Cijena/stanje ZA OVAJ PJ
        if (nacin === 'zamjena') {
          const pjRes = await pool.query(
            `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (roba_id, objekt_id) DO UPDATE SET cijena=$3, stanje=$4, azurirano=now()
             RETURNING (xmax = 0) AS inserted`,
            [robaId, objektId, cijenaFajl, stanjeFajl]
          );
          if (robaRes.rows[0].inserted || pjRes.rows[0].inserted) uneseno++; else azurirano++;
        } else {
          // NABAVKA: pogledaj postojeći red da uporediš cijenu prije nego upišeš
          const postojeci = await pool.query(
            'SELECT cijena, stanje FROM roba_pj WHERE roba_id=$1 AND objekt_id=$2', [robaId, objektId]
          );
          if (!postojeci.rows.length) {
            // Artikal još nema red za ovaj PJ — nema "stare" cijene, upisuje se ona iz fajla.
            await pool.query(
              `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje) VALUES ($1,$2,$3,$4)`,
              [robaId, objektId, cijenaFajl, stanjeFajl]
            );
            uneseno++;
          } else {
            const staraCijena = parseFloat(postojeci.rows[0].cijena);
            const razlikaCijene = mapping.cijena && Math.abs(staraCijena - cijenaFajl) > 0.001;
            if (razlikaCijene) cijenaRazlike.push({ sifra, naziv, stara: staraCijena, nova: cijenaFajl });

            const novaCijena = (razlikaCijene && azurirajCijenu) ? cijenaFajl : staraCijena;
            await pool.query(
              `UPDATE roba_pj SET cijena=$1, stanje = stanje + $2, azurirano=now()
               WHERE roba_id=$3 AND objekt_id=$4`,
              [novaCijena, stanjeFajl, robaId, objektId]
            );
            azurirano++;
          }
        }
      }
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    res.json({
      ok: true, uneseno, azurirano, preskoceno, ukupno_redova: rows.length, kolone: mapping,
      nacin, cijena_razlike: cijenaRazlike.slice(0, 50), broj_cijena_razlike: cijenaRazlike.length,
      cijena_azurirana: nacin === 'nabavka' ? azurirajCijenu : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri uvozu: ' + err.message });
  }
});

module.exports = router;
