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
          `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.aktivan, r.grupa, rp.cijena, rp.stanje
           FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
           WHERE r.aktivan=true ORDER BY r.naziv LIMIT $2`,
          [objektId, lim]
        );
        return res.json(r.rows);
      }
      const r = await pool.query(
        `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.aktivan, r.grupa, rp.cijena, rp.stanje
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
        'SELECT id, sifra, naziv, jed_mjera, aktivan, grupa FROM roba WHERE aktivan=true ORDER BY naziv LIMIT $1', [lim]
      );
      return res.json(r.rows);
    }
    const r = await pool.query(
      `SELECT id, sifra, naziv, jed_mjera, aktivan, grupa FROM roba
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

// GET /api/roba/lager/filteri?objekt_id=X - distinct vrijednosti grupe i debljine za dropdown-e filtera
router.get('/lager/filteri', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može pregledati kompletan lager.' });
  const objektId = trebaObjekat(req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });
  try {
    const r = await pool.query(
      `SELECT DISTINCT r.grupa, r.debljina_cm
       FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
       WHERE r.aktivan=true`,
      [objektId]
    );
    const grupe = [...new Set(r.rows.map(x => x.grupa).filter(Boolean))].sort();
    const debljine = [...new Set(r.rows.map(x => x.debljina_cm).filter(x => x != null))]
      .sort((a, b) => a - b);
    res.json({ grupe, debljine });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roba/lager?objekt_id=X&grupa=Y&debljina=Z - kompletna lager lista za PJ, opciono filtrirana
// po grupi i/ili debljini (kombinuju se — npr. samo "Bengal" + "2cm", ili samo "2cm" svih grupa).
// MORA biti prije "/:id" rute ispod — inače Express tumači "lager" kao vrijednost za :id.
router.get('/lager', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može pregledati kompletan lager.' });
  const objektId = trebaObjekat(req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });
  try {
    const uslovi = ['r.aktivan=true'];
    const vals = [objektId];
    let i = 2;
    if (req.query.grupa) { uslovi.push(`r.grupa = $${i++}`); vals.push(req.query.grupa); }
    if (req.query.debljina) { uslovi.push(`r.debljina_cm = $${i++}`); vals.push(parseFloat(req.query.debljina)); }

    const r = await pool.query(
      `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.grupa, r.debljina_cm, rp.cijena, rp.stanje,
              (rp.cijena * rp.stanje) AS ukupno
       FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
       WHERE ${uslovi.join(' AND ')}
       ORDER BY r.naziv`,
      vals
    );
    const totalVrijednost = r.rows.reduce((s, row) => s + parseFloat(row.ukupno || 0), 0);
    res.json({ stavke: r.rows, total_vrijednost: +totalVrijednost.toFixed(2), broj_artikala: r.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roba/lager/export?objekt_id=X&grupa=Y&debljina=Z - preuzimanje (filtrirane) lager liste kao XLSX
router.get('/lager/export', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može izvoziti lager.' });
  const objektId = trebaObjekat(req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });
  try {
    const objRes = await pool.query('SELECT naziv FROM prodajni_objekti WHERE id=$1', [objektId]);
    const objektNaziv = objRes.rows[0]?.naziv || 'PJ';

    const uslovi = ['r.aktivan=true'];
    const vals = [objektId];
    let i = 2;
    if (req.query.grupa) { uslovi.push(`r.grupa = $${i++}`); vals.push(req.query.grupa); }
    if (req.query.debljina) { uslovi.push(`r.debljina_cm = $${i++}`); vals.push(parseFloat(req.query.debljina)); }

    const r = await pool.query(
      `SELECT r.sifra, r.naziv, r.grupa, r.debljina_cm, r.jed_mjera, rp.cijena, rp.stanje,
              (rp.cijena * rp.stanje) AS ukupno
       FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
       WHERE ${uslovi.join(' AND ')}
       ORDER BY r.naziv`,
      vals
    );

    const podaci = r.rows.map(row => ({
      'Šifra': row.sifra,
      'Naziv': row.naziv,
      'Grupa': row.grupa || '',
      'Debljina (cm)': row.debljina_cm || '',
      'JM': row.jed_mjera,
      'Cijena po JM': parseFloat(row.cijena),
      'Stanje': parseFloat(row.stanje),
      'Ukupno': parseFloat(row.ukupno),
    }));
    const ukupnaVrijednost = podaci.reduce((s, p) => s + p['Ukupno'], 0);
    podaci.push({ 'Šifra': '', 'Naziv': '', 'Grupa': '', 'Debljina (cm)': '', 'JM': '', 'Cijena po JM': '', 'Stanje': 'UKUPNO:', 'Ukupno': +ukupnaVrijednost.toFixed(2) });

    const ws = XLSX.utils.json_to_sheet(podaci);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Lager');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fajlNaziv = `lager_${objektNaziv.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fajlNaziv}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/lager/delete?objekt_id=X - briše KOMPLETAN lager (sve roba_pj redove) za PJ.
// Prije brisanja pravi backup (roba_pj_backup) da bi "Undo" bio moguć. Samo admin.
router.post('/lager/delete', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može brisati lager.' });
  const objektId = trebaObjekat(req.body.objekt_id || req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const objRes = await client.query('SELECT naziv FROM prodajni_objekti WHERE id=$1', [objektId]);
    if (!objRes.rows.length) throw Object.assign(new Error('Prodajni objekat nije pronađen.'), { status: 404 });
    const objektNaziv = objRes.rows[0].naziv;

    const trenutno = await client.query(
      `SELECT r.id AS roba_id, r.sifra, r.naziv, rp.cijena, rp.stanje
       FROM roba_pj rp JOIN roba r ON r.id = rp.roba_id
       WHERE rp.objekt_id = $1`,
      [objektId]
    );

    if (!trenutno.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Lager za ovaj objekat je već prazan — nema šta da se briše.' });
    }

    await client.query(
      `INSERT INTO roba_pj_backup (objekt_id, objekt_naziv, podaci, kreirao_id, kreirao_ime)
       VALUES ($1,$2,$3,$4,$5)`,
      [objektId, objektNaziv, JSON.stringify(trenutno.rows), req.session.user.id, req.session.user.ime_prezime]
    );

    await client.query('DELETE FROM roba_pj WHERE objekt_id=$1', [objektId]);

    await client.query('COMMIT');
    res.json({ ok: true, obrisano: trenutno.rows.length, objekt_naziv: objektNaziv });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/roba/lager/backup-postoji?objekt_id=X - da li postoji backup za Undo dugme
router.get('/lager/backup-postoji', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin.' });
  const objektId = trebaObjekat(req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje objekt_id.' });
  try {
    const r = await pool.query(
      `SELECT id, kreiran, kreirao_ime, jsonb_array_length(podaci) AS broj_stavki
       FROM roba_pj_backup WHERE objekt_id=$1 ORDER BY kreiran DESC LIMIT 1`,
      [objektId]
    );
    res.json(r.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/lager/undo?objekt_id=X - vraća poslednji backup (npr. nakon greškom obrisanog lagera)
router.post('/lager/undo', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može vršiti undo.' });
  const objektId = trebaObjekat(req.body.objekt_id || req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bRes = await client.query(
      `SELECT id, podaci FROM roba_pj_backup WHERE objekt_id=$1 ORDER BY kreiran DESC LIMIT 1 FOR UPDATE`,
      [objektId]
    );
    if (!bRes.rows.length) throw Object.assign(new Error('Nema sačuvane rezervne kopije za ovaj objekat.'), { status: 404 });

    const stavke = bRes.rows[0].podaci;
    for (const s of stavke) {
      await client.query(
        `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (roba_id, objekt_id) DO UPDATE SET cijena=$3, stanje=$4, azurirano=now()`,
        [s.roba_id, objektId, s.cijena, s.stanje]
      );
    }
    await client.query('DELETE FROM roba_pj_backup WHERE id=$1', [bRes.rows[0].id]);

    await client.query('COMMIT');
    res.json({ ok: true, vraceno: stavke.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/roba/najprodavaniji?objekt_id=X&limit=6 - predlog najprodavanijih artikala
// za taj PJ (iz poslednjih potvrđenih otpremnica), za brzi izbor na početku prodaje.
router.get('/najprodavaniji', zahtijevaProdaju, async (req, res) => {
  const objektId = trebaObjekat(req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
  const lim = Math.min(parseInt(req.query.limit) || 6, 20);
  try {
    const r = await pool.query(
      `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.aktivan, r.grupa, rp.cijena, rp.stanje,
              COUNT(*) AS broj_prodaja
       FROM otpremnica_stavke os
       JOIN otpremnice o ON o.id = os.otpremnica_id
       JOIN roba r ON r.id = os.roba_id
       JOIN roba_pj rp ON rp.roba_id = r.id AND rp.objekt_id = $1
       WHERE o.objekt_id = $1 AND o.status = 'potvrdjena' AND r.aktivan = true AND rp.stanje > 0
       GROUP BY r.id, r.sifra, r.naziv, r.jed_mjera, r.aktivan, r.grupa, rp.cijena, rp.stanje
       ORDER BY broj_prodaja DESC
       LIMIT $2`,
      [objektId, lim]
    );
    res.json(r.rows);
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
  grupa:     ['code-group', 'code group', 'grupa', 'group', 'kod grupe', 'tip', 'kategorija'],
  debljina:  ['debljina', 'debljina cm', 'thickness', 'deb'],
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

// Parsira broj iz Excel ćelije, hvatajući i evropski format (tačka=hiljade, zarez=decimale,
// npr. "1.234,56") i standardni JS format ("1234.56"). Prije ovoga se koristio samo
// .replace(',', '.') koji je "1.234,56" pretvarao u "1.234.56" — parseFloat bi to pročitao
// kao 1.234 (stao na drugoj tački), gubeći tri nule iz cijene/stanja.
function parsirajBroj(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) {
    // Oba znaka prisutna -> evropski format: tačka je hiljade, zarez je decimalni separator.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    // Samo zarez -> decimalni separator.
    s = s.replace(',', '.');
  }
  // Samo tačka (ili ništa posebno) -> već je u standardnom formatu, ostaje kako jest.
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
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

  const nacin = ['zamjena', 'nabavka', 'metapodaci'].includes(req.body.nacin) ? req.body.nacin : 'nabavka';

  // Za "metapodaci" ne treba objekt_id — ništa se ne dira u roba_pj (cijena/stanje), samo
  // zajednički šifrarnik (grupa/debljina/naziv/jed_mjera). Za ostala dva režima objekt_id je obavezan.
  let objektId = null;
  if (nacin !== 'metapodaci') {
    objektId = trebaObjekat(req.body.objekt_id);
    if (!objektId) return res.status(400).json({ error: 'Morate izabrati prodajni objekat za koji uvozite lager.' });
  }

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
    const cijenaSeDira = izvor === 'interni'; // Bluesoft NIKAD ne dira cijenu (ni upis ni izmjena)
    const jmDefault = (req.body.jed_mjera_default || 'kom').trim() || 'kom';
    let uneseno = 0, azurirano = 0, preskoceno = 0;
    const cijenaRazlike = []; // { sifra, naziv, stara, nova } — samo za 'nabavka' + interni

    await pool.query('BEGIN');
    try {
      // ZAMJENA: prvo nuliraj stanje SVIH postojećih artikala za ovaj PJ — fajl koji slijedi
      // je nova kompletna istina. Cijena ostaje netaknuta ovim korakom (postavlja je fajl niže,
      // osim za Bluesoft gdje se cijena nikad ne dira).
      if (nacin === 'zamjena') {
        await pool.query('UPDATE roba_pj SET stanje=0, azurirano=now() WHERE objekt_id=$1', [objektId]);
      }

      for (const row of rows) {
        const sifra = String(row[mapping.sifra] ?? '').trim();
        const naziv = String(row[mapping.naziv] ?? '').trim();
        if (!sifra || !naziv) { preskoceno++; continue; }

        const grupa = mapping.grupa ? (String(row[mapping.grupa] ?? '').trim() || null) : null;
        const debljina = mapping.debljina ? (parsirajBroj(row[mapping.debljina]) || null) : null;

        // Ako fajl nema posebnu kolonu za jedinicu mjere, pogađamo po obliku broja u
        // koloni stanja: cijeli broj -> "kom", decimalan -> "m2". Samo POLAZNA pretpostavka —
        // ako trgovac pri prodaji izabere drugačiju jedinicu, sistem to automatski
        // prijavljuje kao odstupanje (vidi otpremnice.js).
        const stanjeFajl = mapping.stanje ? parsirajBroj(row[mapping.stanje]) : 0;
        const jed_mjera = mapping.jed_mjera
          ? (String(row[mapping.jed_mjera] ?? '').trim() || jmDefault)
          : (Number.isInteger(stanjeFajl) && stanjeFajl !== 0 ? 'kom' : 'm2');

        // 1) Šifrarnik (zajednički za sve PJ) — upsert po šifri
        const robaRes = await pool.query(
          `INSERT INTO roba (sifra, naziv, jed_mjera, izvor_uvoza, grupa, debljina_cm)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (sifra) DO UPDATE SET naziv=$2, jed_mjera=$3, izvor_uvoza=$4,
             grupa=COALESCE($5, roba.grupa), debljina_cm=COALESCE($6, roba.debljina_cm), azurirano=now()
           RETURNING id, (xmax = 0) AS inserted`,
          [sifra, naziv, jed_mjera, izvor, grupa, debljina]
        );
        const robaId = robaRes.rows[0].id;

        // "metapodaci" režim staje ovdje — NIKAD ne dira roba_pj (cijenu/stanje).
        if (nacin === 'metapodaci') {
          if (robaRes.rows[0].inserted) uneseno++; else azurirano++;
          continue;
        }

        // Cijena iz fajla se uopšte NE ČITA za Bluesoft — ostaje null (znači "ne diraj").
        const cijenaFajl = cijenaSeDira && mapping.cijena ? parsirajBroj(row[mapping.cijena]) : null;

        // 2) Cijena/stanje ZA OVAJ PJ
        if (nacin === 'zamjena') {
          // cijena = CASE: ako je cijenaFajl null (Bluesoft), postojeća cijena OSTAJE; nova
          // stavka bez postojećeg reda dobija 0. Za interni izvor cijena se uvijek postavlja iz fajla.
          const pjRes = await pool.query(
            `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje)
             VALUES ($1,$2,COALESCE($3,0),$4)
             ON CONFLICT (roba_id, objekt_id) DO UPDATE SET
               cijena = CASE WHEN $3 IS NOT NULL THEN $3 ELSE roba_pj.cijena END,
               stanje = $4, azurirano = now()
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
            // Artikal još nema red za ovaj PJ. Interni izvor upisuje cijenu iz fajla; Bluesoft
            // (cijenaFajl je null) upisuje 0 — admin je mora ručno postaviti kasnije.
            await pool.query(
              `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje) VALUES ($1,$2,$3,$4)`,
              [robaId, objektId, cijenaFajl ?? 0, stanjeFajl]
            );
            uneseno++;
          } else {
            const staraCijena = parseFloat(postojeci.rows[0].cijena);
            // Za Bluesoft je cijenaFajl uvijek null, pa razlikaCijene ostaje false — cijena se
            // NIKAD ne mijenja, bez obzira na checkbox "ažuriraj cijenu".
            const razlikaCijene = cijenaFajl != null && Math.abs(staraCijena - cijenaFajl) > 0.001;
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
