const express = require('express');
const router = express.Router();
const pool = require('./db');
const multer = require('multer');
const XLSX = require('xlsx');
const presekUvoz = require('./presek-uvoz');
const { uploadFile } = require('./storage');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true (dozvola iz korisnici.html).
function zahtijevaProdaju(req, res, next) {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati || u?.komercijalista_teren || u?.moze_ugovarati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
}

function zahtijevaRobaMagacin(req, res, next) {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_roba_magacin) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za modul Roba i magacini.' });
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
          `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.aktivan, r.grupa, rp.cijena, rp.stanje,
                  EXISTS(SELECT 1 FROM roba_slike WHERE roba_id=r.id) AS ima_sliku
           FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
           WHERE r.aktivan=true ORDER BY r.naziv LIMIT $2`,
          [objektId, lim]
        );
        return res.json(r.rows);
      }
      // Pretraga gleda i GRUPU (ne samo šifru i naziv) — komercijalista često zna kojoj
      // grupi artikal pripada ("bengal") iako ne zna tačan naziv varijante.
      const r = await pool.query(
        `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.aktivan, r.grupa, rp.cijena, rp.stanje,
                EXISTS(SELECT 1 FROM roba_slike WHERE roba_id=r.id) AS ima_sliku
         FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
         WHERE r.aktivan=true AND (r.sifra ILIKE $2 OR r.naziv ILIKE $3 OR r.grupa ILIKE $3)
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
       WHERE aktivan=true AND (sifra ILIKE $1 OR naziv ILIKE $2 OR grupa ILIKE $2)
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
router.get('/lager/filteri', zahtijevaRobaMagacin, async (req, res) => {
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
// GET /api/roba/lager-prodaja — ISTI podaci kao /lager, ali za maloprodaju (svako ko
// prodaje smije da vidi, ne samo admin/roba-magacin uloga) i NAMJERNO NE VRAĆA
// total_vrijednost/ukupno po redu — vlasnik ne želi da svaki komercijalista zna koliki je
// ukupan lager u novcu, samo pojedinačnu cijenu i stanje po artiklu. Uključuje sliku.
router.get('/lager-prodaja', zahtijevaProdaju, async (req, res) => {
  const objektId = trebaObjekat(req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });
  try {
    const r = await pool.query(
      `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.grupa, r.debljina_cm,
              rp.cijena, rp.stanje,
              (SELECT COALESCE(thumb_url, url) FROM roba_slike WHERE roba_id=r.id AND glavna=true LIMIT 1) AS glavna_slika,
              r.model_3d_url,
              (SELECT COUNT(*) FROM roba_slike WHERE roba_id=r.id) AS broj_slika
       FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$1
       WHERE r.aktivan=true
       ORDER BY r.naziv`,
      [objektId]
    );
    res.json({ stavke: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/lager', zahtijevaRobaMagacin, async (req, res) => {
  const objektId = trebaObjekat(req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });
  try {
    const uslovi = ['r.aktivan=true'];
    const vals = [objektId];
    let i = 2;
    if (req.query.grupa) { uslovi.push(`r.grupa = $${i++}`); vals.push(req.query.grupa); }
    if (req.query.debljina) { uslovi.push(`r.debljina_cm = $${i++}`); vals.push(parseFloat(req.query.debljina)); }

    const r = await pool.query(
      `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, r.grupa, r.debljina_cm,
              (SELECT COALESCE(thumb_url, url) FROM roba_slike WHERE roba_id=r.id AND glavna=true LIMIT 1) AS glavna_slika,
              r.model_3d_url,
              (SELECT COUNT(*) FROM roba_slike WHERE roba_id=r.id) AS broj_slika,
              rp.cijena, rp.stanje,
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
router.get('/lager/export', zahtijevaRobaMagacin, async (req, res) => {
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
    // Excel-stil filteri na frontendu (moguć izbor VIŠE vrednosti po koloni) se ne mogu
    // prevesti u jednostavne grupa=/debljina= parametre — umjesto toga, frontend šalje
    // TAČNU listu šifri koje su trenutno vidljive (posle svih filtera), i export uzima
    // SAMO njih.
    if (req.query.sifre) {
      const sifre = req.query.sifre.split(',').map(s => s.trim()).filter(Boolean);
      if (sifre.length) { uslovi.push(`r.sifra = ANY($${i++}::text[])`); vals.push(sifre); }
    }

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

// GET /api/roba/lager/backup-lista?objekt_id=X - SVE dostupne tačke za vraćanje (ne samo
// poslednja) — omogućava da se vrati VIŠE koraka unazad, ne samo jedan.
router.get('/lager/backup-lista', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin.' });
  const objektId = trebaObjekat(req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje objekt_id.' });
  try {
    const r = await pool.query(
      `SELECT id, kreiran, kreirao_ime, jsonb_array_length(podaci) AS broj_stavki
       FROM roba_pj_backup WHERE objekt_id=$1 ORDER BY kreiran DESC LIMIT 20`,
      [objektId]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/lager/undo?objekt_id=X&backup_id=Y - vraća ODREĐENI backup (ako je
// backup_id poslat) ili poslednji (ako nije) — omogućava vraćanje VIŠE koraka unazad, ne
// samo na najsvežiji backup. Kad se vrati na stariji backup, SVI backupovi noviji od njega
// se takođe brišu (postali bi nekonzistentni — "redoslijed" bi izgubio smisao).
router.post('/lager/undo', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može vršiti undo.' });
  const objektId = trebaObjekat(req.body.objekt_id || req.query.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat (objekt_id).' });
  const backupId = req.body.backup_id || req.query.backup_id || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bRes = backupId
      ? await client.query(`SELECT id, kreiran, podaci FROM roba_pj_backup WHERE id=$1 AND objekt_id=$2 FOR UPDATE`, [backupId, objektId])
      : await client.query(`SELECT id, kreiran, podaci FROM roba_pj_backup WHERE objekt_id=$1 ORDER BY kreiran DESC LIMIT 1 FOR UPDATE`, [objektId]);
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
    // Obriši ovaj backup i SVE novije od njega (postali bi besmisleni/nekonzistentni ako se
    // sad vratimo na jednu tačku dublje unazad).
    await client.query('DELETE FROM roba_pj_backup WHERE objekt_id=$1 AND kreiran >= $2', [objektId, bRes.rows[0].kreiran]);

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

// GET /api/roba/kretanje-pregled?objekt_id=X&od=YYYY-MM-DD&do=YYYY-MM-DD — DETALJAN
// pregled kretanja robe (jedan red = jedna transakcija, ne zbirno po artiklu) da bi se
// znalo TAČNO od koga je ušlo / kome je izašlo, i da bi filtriranje po partneru/artiklu/
// iznosu bilo moguće na frontu. ISKLJUČIVO za PJ, ne dotiče proizvodnju/radne naloge.
// NAPOMENA: raspon datuma koristi >= / < (ne BETWEEN) jer su izvorne kolone TIMESTAMP —
// BETWEEN 'dan' AND 'dan' bi uhvatio SAMO tačno ponoć, "Danas" ne bi pokazivao ništa.
router.get('/kretanje-pregled', zahtijevaRobaMagacin, async (req, res) => {
  try {
    const objektId = trebaObjekat(req.query.objekt_id);
    if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
    const od = req.query.od;
    const do_ = req.query.do;
    if (!od || !do_) return res.status(400).json({ error: 'Nedostaje period (od/do).' });

    const r = await pool.query(
      `SELECT 'ulaz' AS tip, 'kalkulacija' AS izvor, k.datum, ks.roba_id, ks.sifra, ks.naziv,
              r.jed_mjera, ks.kolicina, (ks.kolicina * ks.prava_nabavna_cijena) AS iznos,
              k.dobavljac AS partner
       FROM kalkulacija_stavke ks
       JOIN kalkulacije k ON k.id = ks.kalkulacija_id
       JOIN roba r ON r.id = ks.roba_id
       WHERE k.objekt_id = $1 AND k.datum >= $2::date AND k.datum < ($3::date + 1)

       UNION ALL

       SELECT 'ulaz', 'prenos', pr.kreiran::date, pr.roba_id, pr.sifra, pr.naziv,
              pr.jed_mjera, pr.kolicina, pr.kolicina * COALESCE(rp.cijena,0),
              'Prenos iz — ' || pr.iz_objekta_naziv
       FROM prenosi_robe pr
       LEFT JOIN roba_pj rp ON rp.roba_id = pr.roba_id AND rp.objekt_id = $1
       WHERE pr.u_objekat_id = $1 AND pr.kreiran::date >= $2::date AND pr.kreiran::date < ($3::date + 1)

       UNION ALL

       SELECT 'izlaz', 'prodaja', o.datum::date, os.roba_id, os.sifra, os.naziv,
              os.jed_mjera, os.kolicina, os.iznos,
              COALESCE(NULLIF(TRIM(o.kupac_naziv),''), 'Kupac nepoznat')
       FROM otpremnica_stavke os
       JOIN otpremnice o ON o.id = os.otpremnica_id
       WHERE o.objekt_id = $1 AND o.status = 'potvrdjena'
         AND o.datum >= $2::date AND o.datum < ($3::date + 1)

       UNION ALL

       SELECT 'izlaz', 'prenos', pr.kreiran::date, pr.roba_id, pr.sifra, pr.naziv,
              pr.jed_mjera, pr.kolicina, pr.kolicina * COALESCE(rp.cijena,0),
              'Prenos u — ' || pr.u_objekat_naziv
       FROM prenosi_robe pr
       LEFT JOIN roba_pj rp ON rp.roba_id = pr.roba_id AND rp.objekt_id = $1
       WHERE pr.iz_objekta_id = $1 AND pr.kreiran::date >= $2::date AND pr.kreiran::date < ($3::date + 1)

       UNION ALL

       -- Usaglašavanja (Presek modul + Ručni unos) — SAMO gdje je stvarno bilo promjene
       -- (prazne/nulte razlike se od početka ne upisuju u roba_kretanja, pa ovo prirodno
       -- ne "zatrpava" listu artiklima kod kojih ništa nije mijenjano).
       SELECT CASE WHEN rk.kolicina >= 0 THEN 'ulaz' ELSE 'izlaz' END, 'usaglasavanje',
              rk.datum::date, rk.roba_id, r.sifra, r.naziv, r.jed_mjera,
              ABS(rk.kolicina), ABS(rk.kolicina) * COALESCE(rk.cijena_nova, rp.cijena, 0),
              COALESCE(rk.korisnik_ime, 'Nepoznato')
       FROM roba_kretanja rk
       JOIN roba r ON r.id = rk.roba_id
       LEFT JOIN roba_pj rp ON rp.roba_id = rk.roba_id AND rp.objekt_id = $1
       WHERE rk.objekt_id = $1 AND rk.tip IN ('korekcija-preseka','rucni-unos')
         AND rk.datum >= $2::date AND rk.datum < ($3::date + 1)

       ORDER BY datum DESC`,
      [objektId, od, do_]
    );

    const stavke = r.rows.map(row => ({
      tip: row.tip, izvor: row.izvor, datum: row.datum,
      roba_id: row.roba_id, sifra: row.sifra, naziv: row.naziv, jed_mjera: row.jed_mjera,
      kolicina: +parseFloat(row.kolicina).toFixed(3), iznos: +parseFloat(row.iznos).toFixed(2),
      partner: row.partner,
    }));

    res.json(stavke);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roba/kretanje-dnevno?objekt_id=X&roba_id=Y&dana=7 — dnevni razlaz za JEDAN
// artikal, poslednjih N dana (za drill-down klikom na red u pregledu).
router.get('/kretanje-dnevno', zahtijevaRobaMagacin, async (req, res) => {
  try {
    const objektId = trebaObjekat(req.query.objekt_id);
    const robaId = req.query.roba_id;
    const dana = Math.min(parseInt(req.query.dana) || 7, 60);
    if (!objektId || !robaId) return res.status(400).json({ error: 'Nedostaje objekt_id ili roba_id.' });

    const r = await pool.query(
      `WITH dani AS (
         SELECT generate_series(CURRENT_DATE - ($3::int - 1), CURRENT_DATE, '1 day')::date AS dan
       ),
       ulazi AS (
         SELECT k.datum AS dan, SUM(ks.kolicina) AS kol
         FROM kalkulacija_stavke ks JOIN kalkulacije k ON k.id = ks.kalkulacija_id
         WHERE k.objekt_id = $1 AND ks.roba_id = $2 AND k.datum >= CURRENT_DATE - ($3::int - 1)
         GROUP BY k.datum
         UNION ALL
         SELECT pr.kreiran::date, SUM(pr.kolicina)
         FROM prenosi_robe pr
         WHERE pr.u_objekat_id = $1 AND pr.roba_id = $2 AND pr.kreiran::date >= CURRENT_DATE - ($3::int - 1)
         GROUP BY pr.kreiran::date
       ),
       izlazi AS (
         SELECT o.datum AS dan, SUM(os.kolicina) AS kol
         FROM otpremnica_stavke os JOIN otpremnice o ON o.id = os.otpremnica_id
         WHERE o.objekt_id = $1 AND os.roba_id = $2 AND o.status = 'potvrdjena' AND o.datum >= CURRENT_DATE - ($3::int - 1)
         GROUP BY o.datum
         UNION ALL
         SELECT pr.kreiran::date, SUM(pr.kolicina)
         FROM prenosi_robe pr
         WHERE pr.iz_objekta_id = $1 AND pr.roba_id = $2 AND pr.kreiran::date >= CURRENT_DATE - ($3::int - 1)
         GROUP BY pr.kreiran::date
       )
       SELECT d.dan,
              COALESCE((SELECT SUM(kol) FROM ulazi u WHERE u.dan = d.dan), 0) AS ulaz,
              COALESCE((SELECT SUM(kol) FROM izlazi iz WHERE iz.dan = d.dan), 0) AS izlaz
       FROM dani d ORDER BY d.dan`,
      [objektId, robaId, dana]
    );
    res.json(r.rows.map(x => ({ dan: x.dan, ulaz: +parseFloat(x.ulaz).toFixed(3), izlaz: +parseFloat(x.izlaz).toFixed(3) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roba/:id?objekt_id=1
// GET /api/roba/trazi-po-nazivu?tekst=X — vraća aktivne artikle čiji NAZIV odgovara datom
// tekstu (koristi se za grupni uvoz slika — naziv fajla slike se poredi sa nazivom
// artikla, ne sa šifrom). Poređenje je u OBA smjera i bez razlike velika/mala slova i
// razmaka/crtica — da uhvati i "Bengal_black_3cm.jpg" za artikal "Bengal black 3cm Par".
router.get('/trazi-po-nazivu', zahtijevaProdaju, async (req, res) => {
  try {
    const tekst = (req.query.tekst || '').trim();
    if (tekst.length < 3) return res.status(400).json({ error: 'Prekratak naziv za pretragu.' });
    // Normalizacija UKLANJA sve razmake/crtice/donje crte (ne zamjenjuje ih razmakom) — da
    // se "ts-30" poklopi sa "TS30" bez razmaka unutar naziva ("Metalne nogare za sto
    // TS30"). Zamjena razmakom bi ovdje promašila (razmak vs. bez razmaka su različiti).
    const r = await pool.query(
      `SELECT id, sifra, naziv FROM roba
       WHERE aktivan=true
         AND (
           regexp_replace(lower(naziv), '[-_\\s]', '', 'g') = regexp_replace(lower($1), '[-_\\s]', '', 'g')
           OR regexp_replace(lower($1), '[-_\\s]', '', 'g') LIKE '%' || regexp_replace(lower(naziv), '[-_\\s]', '', 'g') || '%'
           OR regexp_replace(lower(naziv), '[-_\\s]', '', 'g') LIKE '%' || regexp_replace(lower($1), '[-_\\s]', '', 'g') || '%'
         )
       ORDER BY length(naziv) DESC
       LIMIT 10`,
      [tekst]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roba/pretraga-za-grupu?tekst=X — ŠIRA pretraga po nazivu (za biranje GRUPE
// artikala kroz kvadratiće — npr. "Bengal" vraća SVE Bengal varijante, korisnik bira koje
// tačno idu u tu grupu). Za razliku od trazi-po-nazivu, ovde je dovoljna obična
// podudarnost teksta (ne mora biti skoro tačno poklapanje), i vraća više rezultata.
// GET /api/roba/liste-grupa — SVE jedinstvene vrijednosti grupa polja (za autocomplete
// pri unosu, da korisnik zna tačan naziv grupe).
router.get('/liste-grupa', zahtijevaProdaju, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT grupa FROM roba WHERE aktivan=true AND grupa IS NOT NULL AND grupa != '' ORDER BY grupa`
    );
    res.json(r.rows.map(row => row.grupa));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roba/pretraga-za-grupu?tekst=X — vraća SVE artikle čije GRUPA polje (formalna
// kategorija, ne naziv) odgovara datom tekstu — npr. "Bengal" kao grupa vraća SVE artikle
// u toj grupi (razne debljine/varijante), ne pojedinačne artikle čiji NAZIV sadrži "Bengal".
router.get('/pretraga-za-grupu', zahtijevaProdaju, async (req, res) => {
  try {
    const tekst = (req.query.tekst || '').trim();
    // Prazan tekst = izlistaj CEO magacin (za slučaj kad korisnik ne zna šta traži, pa
    // hoće da prelista i sam izabere). Inače traži po GRUPI, ŠIFRI ili NAZIVU.
    if (!tekst) {
      const r = await pool.query(
        `SELECT id, sifra, naziv, grupa FROM roba WHERE aktivan=true ORDER BY sifra LIMIT 500`
      );
      return res.json(r.rows);
    }
    if (tekst.length < 2) return res.status(400).json({ error: 'Prekratak tekst za pretragu.' });
    const r = await pool.query(
      `SELECT id, sifra, naziv, grupa FROM roba
       WHERE aktivan=true AND (grupa ILIKE '%' || $1 || '%' OR naziv ILIKE '%' || $1 || '%' OR sifra ILIKE $1 || '%')
       ORDER BY naziv LIMIT 200`,
      [tekst]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/slika-grupa — DODAJE JEDNU sliku, ali je poveže sa VIŠE artikala odjednom
// (npr. Bengal u različitim debljinama — ista slika, različite šifre). Slika se upload-uje
// na R2 SAMO JEDNOM (ne duplira se prostor/vreme), a u bazu se upisuje po JEDAN roba_slike
// red za SVAKI izabrani artikal, sve pokazuju na ISTI R2 url.
router.post('/slika-grupa', zahtijevaProdaju, upload.fields([{name:'slika',maxCount:1},{name:'thumb',maxCount:1}]), async (req, res) => {
  const glavniFajl = req.files?.slika?.[0];
  const thumbFajl = req.files?.thumb?.[0];
  if (!glavniFajl) return res.status(400).json({ error: 'Nema fajla.' });
  if (!glavniFajl.mimetype.startsWith('image/'))
    return res.status(400).json({ error: 'Fajl mora biti slika.' });
  let robaIds;
  try { robaIds = JSON.parse(req.body.roba_ids || '[]'); } catch (e) { robaIds = []; }
  if (!Array.isArray(robaIds) || !robaIds.length)
    return res.status(400).json({ error: 'Nije izabran nijedan artikal za grupu.' });

  try {
    const ekstenzija = (glavniFajl.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const vrijeme = Date.now();
    const url = await uploadFile(`roba-slike/grupa-${vrijeme}.${ekstenzija}`, glavniFajl.buffer, glavniFajl.mimetype); // JEDAN upload za sve
    // Mala verzija za tabelu — takođe se otprema SAMO JEDNOM, dijele je svi artikli.
    let thumbUrl = null;
    if (thumbFajl) {
      thumbUrl = await uploadFile(`roba-slike/grupa-${vrijeme}-t.jpg`, thumbFajl.buffer, 'image/jpeg');
    }

    let uspjesno = 0;
    for (const robaId of robaIds) {
      const postojeceRes = await pool.query('SELECT COUNT(*) AS n, COALESCE(MAX(redosled),-1) AS max_red FROM roba_slike WHERE roba_id=$1', [robaId]);
      const jePrva = parseInt(postojeceRes.rows[0].n) === 0;
      const noviRedosled = parseInt(postojeceRes.rows[0].max_red) + 1;
      await pool.query(
        'INSERT INTO roba_slike (roba_id, url, thumb_url, redosled, glavna) VALUES ($1,$2,$3,$4,$5)',
        [robaId, url, thumbUrl, noviRedosled, jePrva]
      );
      uspjesno++;
    }
    res.json({ ok: true, url, thumb_url: thumbUrl, broj_artikala: uspjesno });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri otpremanju slike: ' + err.message });
  }
});

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

// GET /api/roba/:id/kartica?objekt_id=X - robna kartica artikla za taj PJ: spaja uvoz i
// nivelaciju (roba_kretanja), prodaju (otpremnica_stavke), i prenose (prenosi_robe) u
// jedan hronološki prikaz.
router.get('/:id/kartica', zahtijevaProdaju, async (req, res) => {
  try {
    const objektId = trebaObjekat(req.query.objekt_id);
    if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
    const robaId = req.params.id;

    const kretanja = await pool.query(
      `SELECT id, tip, kolicina, cijena_stara, cijena_nova, napomena, korisnik_ime, datum
       FROM roba_kretanja WHERE roba_id=$1 AND objekt_id=$2`,
      [robaId, objektId]
    );
    const prodaja = await pool.query(
      `SELECT s.id, s.kolicina, s.cijena, s.iznos, o.broj, o.datum, o.kupac_naziv, o.status
       FROM otpremnica_stavke s JOIN otpremnice o ON o.id = s.otpremnica_id
       WHERE s.roba_id=$1 AND o.objekt_id=$2`,
      [robaId, objektId]
    );
    const prenosiUlaz = await pool.query(
      `SELECT id, kolicina, iz_objekta_naziv, kreiran, korisnik_ime
       FROM prenosi_robe WHERE roba_id=$1 AND u_objekat_id=$2`,
      [robaId, objektId]
    );
    const prenosiIzlaz = await pool.query(
      `SELECT id, kolicina, u_objekat_naziv, kreiran, korisnik_ime
       FROM prenosi_robe WHERE roba_id=$1 AND iz_objekta_id=$2`,
      [robaId, objektId]
    );

    const stavke = [
      ...kretanja.rows.map(k => ({
        tip: k.tip, datum: k.datum,
        opis: k.tip === 'uvoz'
          ? `Uvoz — ${k.kolicina} kom po ${parseFloat(k.cijena_nova).toFixed(2)} KM${k.napomena ? ' (' + k.napomena + ')' : ''}`
          : `Nivelacija cijene — ${parseFloat(k.cijena_stara ?? 0).toFixed(2)} → ${parseFloat(k.cijena_nova).toFixed(2)} KM${k.napomena ? ' (' + k.napomena + ')' : ''}`,
        kolicina: k.kolicina, znak: k.kolicina != null ? '+' : '',
        korisnik: k.korisnik_ime,
      })),
      ...prodaja.rows.map(s => ({
        tip: s.status === 'stornirana' ? 'prodaja_stornirana' : 'prodaja', datum: s.datum,
        opis: `${s.status === 'stornirana' ? '⛔ STORNIRANO — ' : ''}Otpremnica ${s.broj} — ${s.kupac_naziv || 'kupac nepoznat'} — ${parseFloat(s.cijena).toFixed(2)} KM/kom`,
        kolicina: s.status === 'stornirana' ? null : s.kolicina, znak: '−',
        korisnik: null,
      })),
      ...prenosiUlaz.rows.map(p => ({
        tip: 'prenos_ulaz', datum: p.kreiran,
        opis: `Prenos iz "${p.iz_objekta_naziv}"`, kolicina: p.kolicina, znak: '+', korisnik: p.korisnik_ime,
      })),
      ...prenosiIzlaz.rows.map(p => ({
        tip: 'prenos_izlaz', datum: p.kreiran,
        opis: `Prenos u "${p.u_objekat_naziv}"`, kolicina: p.kolicina, znak: '−', korisnik: p.korisnik_ime,
      })),
    ].sort((a, b) => new Date(b.datum) - new Date(a.datum));

    res.json(stavke);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/:id/nivelacija - SAMO admin. Ručna izmjena cijene artikla za taj PJ,
// bilježi se u roba_kretanja (istorija — vidi se u kartici) sa razlogom.
router.post('/:id/nivelacija', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može mijenjati cijenu (nivelacija).' });
  try {
    const objektId = trebaObjekat(req.body.objekt_id);
    if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
    const novaCijena = parseFloat(req.body.cijena);
    if (isNaN(novaCijena) || novaCijena < 0) return res.status(400).json({ error: 'Unesite ispravnu cijenu.' });
    const napomena = (req.body.napomena || '').trim() || null;

    const staraRes = await pool.query('SELECT cijena FROM roba_pj WHERE roba_id=$1 AND objekt_id=$2', [req.params.id, objektId]);
    if (!staraRes.rows.length) return res.status(404).json({ error: 'Artikal nije pronađen za ovaj PJ.' });
    const staraCijena = parseFloat(staraRes.rows[0].cijena);

    await pool.query('UPDATE roba_pj SET cijena=$1, azurirano=now() WHERE roba_id=$2 AND objekt_id=$3', [novaCijena, req.params.id, objektId]);
    await pool.query(
      `INSERT INTO roba_kretanja (roba_id, objekt_id, tip, cijena_stara, cijena_nova, napomena, korisnik_id, korisnik_ime)
       VALUES ($1,$2,'nivelacija',$3,$4,$5,$6,$7)`,
      [req.params.id, objektId, staraCijena, novaCijena, napomena, req.session.user.id, req.session.user.ime_prezime]
    );
    res.json({ ok: true, cijena_stara: staraCijena, cijena_nova: novaCijena });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
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
         VALUES ($1,$2,COALESCE($3::numeric,0),COALESCE($4::numeric,0))
         ON CONFLICT (roba_id, objekt_id) DO UPDATE SET
           cijena=COALESCE($3::numeric, roba_pj.cijena), stanje=COALESCE($4::numeric, roba_pj.stanje), azurirano=now()
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

function citajRadniList(buffer, sheetName) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ime = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  const sheet = wb.Sheets[ime];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

// Vraća samo listu naziva listova (sheet-ova) u fajlu — koristi se da frontend ponudi
// izbor kad fajl ima više od jednog lista.
function listaSheetova(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return wb.SheetNames;
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
    const sheetovi = listaSheetova(req.file.buffer);
    const izabraniSheet = req.body.sheet || sheetovi[0];
    const rows = citajRadniList(req.file.buffer, izabraniSheet);
    if (!rows.length) return res.status(400).json({ error: `List "${izabraniSheet}" je prazan.` });

    const header = Object.keys(rows[0]);
    const predlog = nagadjajMapiranje(header);

    res.json({
      header, uzorak: rows.slice(0, 5), predlog, ukupno_redova: rows.length,
      sheetovi, izabrani_sheet: izabraniSheet,
    });
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
    const rows = citajRadniList(req.file.buffer, req.body.sheet);
    if (!rows.length) return res.status(400).json({ error: 'Fajl je prazan.' });

    const izvor = req.body.izvor === 'interni' ? 'interni' : 'bluesoft';
    const cijenaSeDira = izvor === 'interni'; // Bluesoft NIKAD ne dira cijenu (ni upis ni izmjena)
    const jmDefault = (req.body.jed_mjera_default || 'kom').trim() || 'kom';
    let uneseno = 0, azurirano = 0, preskoceno = 0;
    const cijenaRazlike = []; // { sifra, naziv, stara, nova } — samo za 'nabavka' + interni
    const preskoceniDetalji = []; // { red, sifra, naziv } — da korisnik može tačno da locira u Excel-u ŠTA je preskočeno i ZAŠTO
    const vidjeneSifre = new Map(); // sifra -> prvi excel_red gdje se pojavila (za otkrivanje duplikata)
    const duplikati = []; // { sifra, naziv, prvi_red, drugi_red } — druga pojava TIHO PREPIŠE prvu (ON CONFLICT), ne sabira se
    let ukupnaVrijednostFajla = 0; // suma (kolicina × cijena) SVIH validnih redova u fajlu — za poređenje sa stvarnim stanjem u bazi

    await pool.query('BEGIN');
    let uvozBatchId = null;
    try {
      // Kreira JEDAN "uvoz_batch" red koji predstavlja CIJELI ovaj upload kao cjelinu —
      // svaka roba_kretanja stavka niže se taguje sa ovim ID-em, da se cijeli uvoz može
      // kasnije pregledati/stornirati odjednom (umjesto stavku-po-stavku).
      if (nacin !== 'metapodaci') {
        const batchRes = await pool.query(
          `INSERT INTO uvoz_batch (objekt_id, objekt_naziv, naziv_fajla, nacin, korisnik_id, korisnik_ime)
           VALUES ($1,(SELECT naziv FROM prodajni_objekti WHERE id=$1),$2,$3,$4,$5) RETURNING id`,
          [objektId, req.file.originalname || null, nacin, req.session.user.id, req.session.user.ime_prezime]
        );
        uvozBatchId = batchRes.rows[0].id;
      }

      // ZAMJENA: prvo nuliraj stanje SVIH postojećih artikala za ovaj PJ — fajl koji slijedi
      // je nova kompletna istina. Cijena ostaje netaknuta ovim korakom (postavlja je fajl niže,
      // osim za Bluesoft gdje se cijena nikad ne dira).
      if (nacin === 'zamjena') {
        await pool.query('UPDATE roba_pj SET stanje=0, azurirano=now() WHERE objekt_id=$1', [objektId]);
      }

      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        const sifra = String(row[mapping.sifra] ?? '').trim();
        const naziv = String(row[mapping.naziv] ?? '').trim();
        if (!sifra || !naziv) {
          preskoceno++;
          // Red u Excel-u je idx+2 (header je red 1, rows[0] je Excel red 2) — tako korisnik
          // može direktno da ga pronađe u svom fajlu, ne mora ručno da broji.
          preskoceniDetalji.push({
            excel_red: idx + 2,
            sifra: sifra || '(prazno)',
            naziv: naziv || '(prazno)',
            razlog: !sifra && !naziv ? 'Nema ni šifru ni naziv' : !sifra ? 'Nema šifru' : 'Nema naziv',
          });
          continue;
        }

        // Duplikat šifre UNUTAR ISTOG fajla — druga (i svaka sljedeća) pojava TIHO PREPIŠE
        // prethodnu (ON CONFLICT DO UPDATE dolje), ne sabira količine. Ovo je čest uzrok
        // "ne slaže mi se ukupna vrijednost" — bilježimo da korisnik odmah vidi gdje je nestalo.
        if (vidjeneSifre.has(sifra)) {
          duplikati.push({
            sifra, naziv,
            prvi_red: vidjeneSifre.get(sifra),
            drugi_red: idx + 2,
          });
        } else {
          vidjeneSifre.set(sifra, idx + 2);
        }

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
        // KRITIČNO: prazna ćelija za cijenu MORA ostati null (= "nema podatak, ne diraj
        // postojeću cijenu"), NE smije postati 0 (parsirajBroj('') vraća 0, što bi ovdje
        // pogrešno izgledalo kao "stvarna nova cijena je 0" i PREPISALO ispravnu cijenu).
        // Ovo je bio stvaran uzrok gubitka vrijednosti kod dupliranih šifri (prazan duplikat
        // red bi obrisao cijenu unesenu u prvom redu).
        const cijenaSirova = mapping.cijena ? String(row[mapping.cijena] ?? '').trim() : '';
        const cijenaFajl = cijenaSeDira && mapping.cijena && cijenaSirova !== '' ? parsirajBroj(row[mapping.cijena]) : null;
        // Zbir SVIH validnih redova KAKO STOJE U FAJLU (uključujući duplikate, računati
        // pojedinačno) — za poređenje "šta Excel sam pokazuje kao ukupno" naspram onoga
        // što stvarno završi u bazi (koje je manje ako je bilo duplikata, jer se ne sabiraju).
        if (cijenaFajl !== null) ukupnaVrijednostFajla += (stanjeFajl || 0) * cijenaFajl;

        // 2) Cijena/stanje ZA OVAJ PJ
        if (nacin === 'zamjena') {
          // cijena = CASE: ako je cijenaFajl null (Bluesoft), postojeća cijena OSTAJE; nova
          // stavka bez postojećeg reda dobija 0. Za interni izvor cijena se uvijek postavlja iz fajla.
          const pjRes = await pool.query(
            `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje)
             VALUES ($1,$2,COALESCE($3::numeric,0),$4::numeric)
             ON CONFLICT (roba_id, objekt_id) DO UPDATE SET
               cijena = CASE WHEN $3::numeric IS NOT NULL THEN $3::numeric ELSE roba_pj.cijena END,
               stanje = $4::numeric, azurirano = now()
             RETURNING (xmax = 0) AS inserted`,
            [robaId, objektId, cijenaFajl, stanjeFajl]
          );
          if (robaRes.rows[0].inserted || pjRes.rows[0].inserted) uneseno++; else azurirano++;
          if (stanjeFajl > 0) {
            await pool.query(
              `INSERT INTO roba_kretanja (roba_id, objekt_id, tip, kolicina, cijena_nova, napomena, korisnik_id, korisnik_ime, uvoz_batch_id)
               VALUES ($1,$2,'uvoz',$3,$4,$5,$6,$7,$8)`,
              [robaId, objektId, stanjeFajl, cijenaFajl ?? 0, 'Uvoz (zamjena kompletnog lagera)',
               req.session.user.id, req.session.user.ime_prezime, uvozBatchId]
            );
          }
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
            if (stanjeFajl > 0) {
              await pool.query(
                `INSERT INTO roba_kretanja (roba_id, objekt_id, tip, kolicina, cijena_nova, napomena, korisnik_id, korisnik_ime, uvoz_batch_id)
                 VALUES ($1,$2,'uvoz',$3,$4,$5,$6,$7,$8)`,
                [robaId, objektId, stanjeFajl, cijenaFajl ?? 0, 'Uvoz (nabavka — novi artikal za ovaj PJ)',
                 req.session.user.id, req.session.user.ime_prezime, uvozBatchId]
              );
            }
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
            if (stanjeFajl > 0) {
              await pool.query(
                `INSERT INTO roba_kretanja (roba_id, objekt_id, tip, kolicina, cijena_nova, napomena, korisnik_id, korisnik_ime, uvoz_batch_id)
                 VALUES ($1,$2,'uvoz',$3,$4,$5,$6,$7,$8)`,
                [robaId, objektId, stanjeFajl, novaCijena, 'Uvoz (nabavka — dodato na postojeće stanje)',
                 req.session.user.id, req.session.user.ime_prezime, uvozBatchId]
              );
            }
          }
        }
      }
      if (uvozBatchId) {
        await pool.query(
          `UPDATE uvoz_batch SET broj_stavki=$1, broj_novih=$2, broj_azuriranih=$3 WHERE id=$4`,
          [uneseno + azurirano, uneseno, azurirano, uvozBatchId]
        );
      }
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    // Stvarna ukupna vrijednost u bazi za ovaj PJ NAKON uvoza (kolicina × cijena, sabrano
    // preko svih artikala) — poređenje sa ukupnaVrijednostFajla otkriva razliku odmah.
    let stvarnaVrijednostBaza = null;
    if (nacin !== 'metapodaci' && objektId) {
      const vr = await pool.query(
        `SELECT COALESCE(SUM(stanje * cijena), 0) AS ukupno FROM roba_pj WHERE objekt_id=$1`,
        [objektId]
      );
      stvarnaVrijednostBaza = +parseFloat(vr.rows[0].ukupno).toFixed(2);
    }

    res.json({
      ok: true, uneseno, azurirano, preskoceno, ukupno_redova: rows.length, kolone: mapping,
      nacin, cijena_razlike: cijenaRazlike.slice(0, 50), broj_cijena_razlike: cijenaRazlike.length,
      cijena_azurirana: nacin === 'nabavka' ? azurirajCijenu : null,
      preskoceni_detalji: preskoceniDetalji.slice(0, 200),
      duplikati_sifre: duplikati.slice(0, 200), broj_duplikata: duplikati.length,
      ukupna_vrijednost_fajla: +ukupnaVrijednostFajla.toFixed(2),
      stvarna_vrijednost_baza: stvarnaVrijednostBaza,
      // Dijagnostika (privremeno) — da vidimo tačno šta je server primio ako cijena
      // opet ne bude uvezena: izvor koji je stigao, da li se cijena uopšte dira, i
      // koja kolona je mapirana na cijenu.
      _debug: { izvor_primljen: izvor, cijena_se_dira: cijenaSeDira, mapping_cijena: mapping.cijena || null },
    });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri uvozu: ' + err.message });
  }
});

// GET /api/roba/uvoz-batch?objekt_id=X — istorija uvoza (XLSX upload-a), grupisano po
// cijelom fajlu (ne stavka-po-stavku) — za pregled i storniranje.
router.get('/uvoz-batch', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const { objekt_id } = req.query;
    let where = '';
    let vals = [];
    if (objekt_id) { where = 'WHERE objekt_id=$1'; vals.push(objekt_id); }
    const r = await pool.query(
      `SELECT * FROM uvoz_batch ${where} ORDER BY kreirano DESC LIMIT 100`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/uvoz-batch/:id/storniraj — poništava CIJEL uvoz kao cjelinu: oduzima
// nazad SVE količine koje je taj uvoz dodao (vraća stanje na ono prije uvoza), i markira
// batch kao storniran. SIGURNOSNA PROVJERA: ako bi BILO KOJA stavka pala ispod nule
// (znači da je dio te robe već prodat/premešten posle uvoza), CEO storno se odbija —
// ništa se ne mijenja dok se ne razriješi ručno (ne dozvoljava djelimičan/nekonzistentan storno).
router.post('/uvoz-batch/:id/storniraj', async (req, res) => {
  const user = req.session?.user;
  if (user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin može stornirati uvoz.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batchRes = await client.query('SELECT * FROM uvoz_batch WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!batchRes.rows.length) throw Object.assign(new Error('Uvoz nije pronađen.'), { status: 404 });
    const batch = batchRes.rows[0];
    if (batch.stornirano) throw Object.assign(new Error('Ovaj uvoz je već storniran.'), { status: 400 });

    const stavke = await client.query(
      `SELECT roba_id, objekt_id, SUM(kolicina) AS kolicina
       FROM roba_kretanja WHERE uvoz_batch_id=$1 GROUP BY roba_id, objekt_id`,
      [req.params.id]
    );
    if (!stavke.rows.length) throw Object.assign(new Error('Nema stavki za ovaj uvoz (možda je star, prije uvođenja ove funkcije).'), { status: 400 });

    // Performanse: umjesto 1 upita PO STAVCI (mogao je biti stotine kod velikog uvoza),
    // sve tri operacije ispod (provjera stanja, umanjenje stanja, upis storno-tragova) se
    // radi u JEDNOM upitu svaka, preko unnest() — baza upari niz sa svakom stavkom odjednom.
    const robaIds = stavke.rows.map(s => s.roba_id);
    const objektIds = stavke.rows.map(s => s.objekt_id);
    const kolicine = stavke.rows.map(s => parseFloat(s.kolicina));

    const provjera = await client.query(`
      SELECT v.roba_id, v.objekt_id, v.kolicina AS uvoz_kolicina,
             r.sifra, r.naziv, COALESCE(rp.stanje,0) AS stanje
      FROM unnest($1::int[], $2::int[], $3::numeric[]) AS v(roba_id, objekt_id, kolicina)
      JOIN roba r ON r.id = v.roba_id
      LEFT JOIN roba_pj rp ON rp.roba_id = v.roba_id AND rp.objekt_id = v.objekt_id
    `, [robaIds, objektIds, kolicine]);

    const problemi = [];
    for (const row of provjera.rows) {
      if (parseFloat(row.stanje) - parseFloat(row.uvoz_kolicina) < -0.001) {
        problemi.push(`${row.sifra} (${row.naziv}): na stanju ${row.stanje}, uvoz je dodao ${row.uvoz_kolicina} — dio je već prodat/premešten, ne može se stornirati automatski.`);
      }
    }
    if (problemi.length) throw Object.assign(new Error('Storno odbijen — sledeće stavke bi pale ispod nule:\n' + problemi.join('\n')), { status: 409 });

    await client.query(`
      UPDATE roba_pj SET stanje = stanje - v.kolicina, azurirano = now()
      FROM unnest($1::int[], $2::int[], $3::numeric[]) AS v(roba_id, objekt_id, kolicina)
      WHERE roba_pj.roba_id = v.roba_id AND roba_pj.objekt_id = v.objekt_id
    `, [robaIds, objektIds, kolicine]);

    await client.query(`
      INSERT INTO roba_kretanja (roba_id, objekt_id, tip, kolicina, napomena, korisnik_id, korisnik_ime, uvoz_batch_id)
      SELECT v.roba_id, v.objekt_id, 'storno-uvoza', -v.kolicina, $4, $5, $6, $7
      FROM unnest($1::int[], $2::int[], $3::numeric[]) AS v(roba_id, objekt_id, kolicina)
    `, [robaIds, objektIds, kolicine, `Storno uvoza #${batch.id} (${batch.naziv_fajla || ''})`, user.id, user.ime_prezime, batch.id]);

    await client.query(
      `UPDATE uvoz_batch SET stornirano=true, stornirao_id=$1, stornirao_ime=$2, stornirano_kada=now() WHERE id=$3`,
      [user.id, user.ime_prezime, batch.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, stavki_stornirano: stavke.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/roba/lager-pragovi — pragovi za bojenje "Stanje" kolone u Lager listi.
router.get('/lager-pragovi', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const r = await pool.query(`SELECT kljuc, vrijednost FROM lager_postavke`);
    const mapa = {};
    r.rows.forEach(row => { mapa[row.kljuc] = parseFloat(row.vrijednost); });
    res.json({
      prag_zuto: mapa.prag_zuto ?? 15,
      prag_narandzasto: mapa.prag_narandzasto ?? 30,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/roba/lager-pragovi — samo admin mijenja pragove.
router.put('/lager-pragovi', async (req, res) => {
  if (req.session?.user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin.' });
  const { prag_zuto, prag_narandzasto } = req.body || {};
  if (!(parseFloat(prag_zuto) >= 0) || !(parseFloat(prag_narandzasto) >= 0))
    return res.status(400).json({ error: 'Neispravne vrijednosti pragova.' });
  if (parseFloat(prag_narandzasto) < parseFloat(prag_zuto))
    return res.status(400).json({ error: 'Narandžasti prag mora biti veći ili jednak žutom.' });
  try {
    await pool.query(
      `INSERT INTO lager_postavke (kljuc, vrijednost) VALUES ('prag_zuto',$1)
       ON CONFLICT (kljuc) DO UPDATE SET vrijednost=$1`, [prag_zuto]
    );
    await pool.query(
      `INSERT INTO lager_postavke (kljuc, vrijednost) VALUES ('prag_narandzasto',$1)
       ON CONFLICT (kljuc) DO UPDATE SET vrijednost=$1`, [prag_narandzasto]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/presek/pregled — čita XLSX, upoređuje SVAKI red sa TRENUTNIM stanjem u
// bazi, vraća potpun pregled (NIŠTA se ne upisuje ovdje). Frontend prikazuje ovo kao
// Excel-stil tabelu, korisnik ispravlja šta treba, TEK ONDA se zove /primeni.
router.post('/presek/pregled', upload.single('file'), async (req, res) => {
  if (req.session?.user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin.' });
  try {
    const objektId = req.body.objekt_id;
    if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
    if (!req.file) return res.status(400).json({ error: 'Nema fajla.' });

    const { redovi } = presekUvoz.citajList(req.file.buffer, req.body.list);
    const { greska, stavke } = presekUvoz.pripremi(redovi);
    if (greska) return res.status(400).json({ error: greska });

    // Za SVAKI red koji je uspješno parsiran (ima šifru), uporedi sa bazom.
    const sifre = stavke.filter(s => s.status !== 'greska').map(s => s.sifra);
    let postojeci = new Map();
    if (sifre.length) {
      const r = await pool.query(
        `SELECT r.sifra, r.id AS roba_id, r.naziv, r.grupa, r.jed_mjera, rp.stanje, rp.cijena
         FROM roba r LEFT JOIN roba_pj rp ON rp.roba_id = r.id AND rp.objekt_id = $1
         WHERE r.sifra = ANY($2::text[])`,
        [objektId, sifre]
      );
      r.rows.forEach(row => postojeci.set(row.sifra, row));
    }

    const konacno = stavke.map(s => {
      if (s.status === 'greska') return s;
      const p = postojeci.get(s.sifra);
      if (!p) {
        return { ...s, status: 'nova-sifra', roba_id: null, stanje_staro: null, cijena_stara: null };
      }
      const stanjeStaro = parseFloat(p.stanje || 0);
      const razlika = +(s.stanje_novo - stanjeStaro).toFixed(3);
      let noviStatus;
      if (Math.abs(razlika) < 0.001) noviStatus = 'isto';
      else if (razlika > 0) noviStatus = 'povecano';
      else noviStatus = 'smanjeno';
      return {
        ...s, status: noviStatus, roba_id: p.roba_id,
        stanje_staro: stanjeStaro, cijena_stara: parseFloat(p.cijena || 0),
        razlika, naziv: s.naziv || p.naziv, grupa: s.grupa || p.grupa, jm: s.jm || p.jed_mjera,
      };
    });

    res.json({ stavke: konacno, naziv_fajla: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

// POST /api/roba/presek/primeni — prima KONAČNE (možda ručno ispravljene na frontend-u)
// redove i upisuje razliku. Ništa se ne briše — samo se DODAJE korekcija (pozitivna ili
// negativna) kao nov roba_kretanja red, grupisano u presek_batch (može se pregledati i
// stornirati kao cjelina, isti obrazac kao uvoz_batch).
router.post('/presek/primeni', async (req, res) => {
  if (req.session?.user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin.' });
  const { objekt_id, stavke, naziv_fajla, azuriraj_cene, azuriraj_stanje } = req.body || {};
  if (!objekt_id || !Array.isArray(stavke) || !stavke.length)
    return res.status(400).json({ error: 'Nema stavki za primjenu.' });
  // Podrazumevano NE dira cene — presek nekad dolazi iz izvora (npr. Bluesoft) gdje
  // "cena" kolona NIJE prodajna cena koju JoPeX koristi, pa bi je nesvesno pregazila.
  // Admin mora eksplicitno da uključi "Ažuriraj i cene" da bi se cena uopšte dirala.
  const dirajCene = azuriraj_cene === true;
  // Podrazumevano SE dira stanje (postojeće ponašanje) — eksplicitno false znači "ovaj fajl
  // je star/samo za cene, ne diraj stanje" (npr. stariji Bluesoft izvoz sa ispravnim
  // cenama koje treba vratiti, bez uticaja na trenutne stvarne količine).
  const dirajStanje = azuriraj_stanje !== false;

  const user = req.session.user;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const objRes = await client.query('SELECT naziv FROM prodajni_objekti WHERE id=$1', [objekt_id]);
    const batchRes = await client.query(
      `INSERT INTO presek_batch (objekt_id, objekt_naziv, naziv_fajla, korisnik_id, korisnik_ime)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [objekt_id, objRes.rows[0]?.naziv || null, naziv_fajla || null, user.id, user.ime_prezime]
    );
    const batchId = batchRes.rows[0].id;

    let novih = 0, povecanih = 0, smanjenih = 0, nepromijenjenih = 0;
    // Brojač STVARNO promijenjenih cijena — služi kao DOKAZ u izvještaju. Kad je
    // "Ažuriraj cene" isključeno, ovaj broj MORA biti 0 (osim za potpuno nove artikle
    // koji nemaju postojeću cijenu pa je uzimaju iz fajla).
    let cijenaPromijenjeno = 0, cijenaZadrzana = 0;

    for (const s of stavke) {
      if (s.status === 'greska' || s.status === 'isto') { if (s.status === 'isto') nepromijenjenih++; continue; }
      if (!s.sifra || !/^\d{1,6}$/.test(String(s.sifra))) continue; // sigurnosna provjera i ovdje, ne samo na frontendu

      let robaId = s.roba_id;
      if (!robaId) {
        // Nova šifra — kreiraj artikal (isti obrazac kao postojeći uvoz za novu šifru).
        const noviArtikal = await client.query(
          `INSERT INTO roba (sifra, naziv, grupa, jed_mjera)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (sifra) DO UPDATE SET naziv=EXCLUDED.naziv
           RETURNING id`,
          [s.sifra, s.naziv || s.sifra, s.grupa || null, s.jm || 'kom']
        );
        robaId = noviArtikal.rows[0].id;
        novih++;
      } else if (s.status === 'povecano') povecanih++;
      else if (s.status === 'smanjeno') smanjenih++;

      const stanjeNovo = parseFloat(s.stanje_novo) || 0;
      const cijenaNova = parseFloat(s.cijena_nova) || 0;
      const postojeciRes = await client.query('SELECT cijena, stanje FROM roba_pj WHERE roba_id=$1 AND objekt_id=$2', [robaId, objekt_id]);
      const cijenaStara = postojeciRes.rows[0] ? parseFloat(postojeciRes.rows[0].cijena) : null;
      const stanjeStaroIzBaze = postojeciRes.rows[0] ? parseFloat(postojeciRes.rows[0].stanje) : null;
      // Ako admin NIJE uključio "Ažuriraj i cene" — zadrži POSTOJEĆU cenu.
      // Ako je isključio "Ažuriraj stanje" (npr. stari fajl, samo za ispravku cena) —
      // zadrži POSTOJEĆE stanje, ne piši novo iz fajla.
      const stanjeZaUpis = dirajStanje ? stanjeNovo : (stanjeStaroIzBaze ?? stanjeNovo);
      const cijenaZaUpis = dirajCene ? cijenaNova : (cijenaStara ?? cijenaNova);
      // Prati se STVARNA promjena cijene (za izvještaj/dokaz).
      if (cijenaStara !== null && Math.abs(cijenaStara - cijenaZaUpis) > 0.001) cijenaPromijenjeno++;
      else if (cijenaStara !== null) cijenaZadrzana++;
      await client.query(
        `INSERT INTO roba_pj (roba_id, objekt_id, cijena, stanje)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (roba_id, objekt_id) DO UPDATE SET cijena=$3, stanje=$4, azurirano=now()`,
        [robaId, objekt_id, cijenaZaUpis, stanjeZaUpis]
      );

      const staroStanje = parseFloat(s.stanje_staro) || 0;
      const razlika = dirajStanje ? +(stanjeNovo - staroStanje).toFixed(3) : 0;
      const cijenaSePromijenila = dirajCene && cijenaStara !== null && Math.abs(cijenaStara - cijenaNova) > 0.001;
      // Beleži audit trag ako se PROMIJENILA kolicina ILI cena (ranije se beležilo SAMO
      // ako se kolicina promijenila — promjena SAMO cene je prolazila potpuno bez traga).
      if (Math.abs(razlika) > 0.001 || cijenaSePromijenila) {
        await client.query(
          `INSERT INTO roba_kretanja (roba_id, objekt_id, tip, kolicina, cijena_stara, cijena_nova, napomena, korisnik_id, korisnik_ime, presek_batch_id)
           VALUES ($1,$2,'korekcija-preseka',$3,$4,$5,$6,$7,$8,$9)`,
          [robaId, objekt_id, razlika, cijenaStara, dirajCene ? cijenaNova : cijenaStara,
           `Presek/usaglašavanje — ${dirajStanje?`staro stanje ${staroStanje}, novo ${stanjeNovo}`:'stanje NIJE dirano (samo cene)'}${cijenaSePromijenila?` | cena: ${cijenaStara} → ${cijenaNova}`:''}`,
           user.id, user.ime_prezime, batchId]
        );
      }
    }

    await client.query(
      `UPDATE presek_batch SET broj_stavki=$1, broj_novih=$2, broj_povecanih=$3, broj_smanjenih=$4, broj_nepromijenjenih=$5 WHERE id=$6`,
      [stavke.length, novih, povecanih, smanjenih, nepromijenjenih, batchId]
    );

    await client.query('COMMIT');
    res.json({ ok: true, batch_id: batchId, novih, povecanih, smanjenih, nepromijenjenih,
               cijena_promijenjeno: cijenaPromijenjeno, cijena_zadrzana: cijenaZadrzana,
               dirane_cene: dirajCene, dirano_stanje: dirajStanje });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Greška: ' + err.message });
  } finally {
    client.release();
  }
});

// GET /api/roba/presek-batch?objekt_id=X — istorija preseka (za pregled/storniranje),
// isti obrazac kao uvoz-batch.
router.get('/presek-batch', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const { objekt_id } = req.query;
    let where = '';
    let vals = [];
    if (objekt_id) { where = 'WHERE objekt_id=$1'; vals.push(objekt_id); }
    const r = await pool.query(`SELECT * FROM presek_batch ${where} ORDER BY kreirano DESC LIMIT 100`, vals);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/presek-batch/:id/storniraj — poništava CIJEL presek kao cjelinu, vraća
// stanje na ono PRIJE preseka (oduzima upisanu razliku). Isti obrazac (i sigurnosna
// provjera ispod nule) kao uvoz-batch storniraj.
router.post('/presek-batch/:id/storniraj', async (req, res) => {
  const user = req.session?.user;
  if (user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin može stornirati presek.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batchRes = await client.query('SELECT * FROM presek_batch WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!batchRes.rows.length) throw Object.assign(new Error('Presek nije pronađen.'), { status: 404 });
    const batch = batchRes.rows[0];
    if (batch.stornirano) throw Object.assign(new Error('Ovaj presek je već storniran.'), { status: 400 });

    const stavke = await client.query(
      `SELECT roba_id, objekt_id, SUM(kolicina) AS kolicina
       FROM roba_kretanja WHERE presek_batch_id=$1 GROUP BY roba_id, objekt_id`,
      [req.params.id]
    );
    if (!stavke.rows.length) throw Object.assign(new Error('Nema stavki za ovaj presek.'), { status: 400 });

    const robaIds = stavke.rows.map(s => s.roba_id);
    const objektIds = stavke.rows.map(s => s.objekt_id);
    const kolicine = stavke.rows.map(s => parseFloat(s.kolicina));

    const provjera = await client.query(`
      SELECT v.roba_id, v.objekt_id, v.kolicina AS presek_kolicina,
             r.sifra, r.naziv, COALESCE(rp.stanje,0) AS stanje
      FROM unnest($1::int[], $2::int[], $3::numeric[]) AS v(roba_id, objekt_id, kolicina)
      JOIN roba r ON r.id = v.roba_id
      LEFT JOIN roba_pj rp ON rp.roba_id = v.roba_id AND rp.objekt_id = v.objekt_id
    `, [robaIds, objektIds, kolicine]);

    const problemi = [];
    for (const row of provjera.rows) {
      if (parseFloat(row.stanje) - parseFloat(row.presek_kolicina) < -0.001) {
        problemi.push(`${row.sifra} (${row.naziv}): na stanju ${row.stanje}, presek je dodao ${row.presek_kolicina} — dio je već prodat/premešten, ne može se stornirati automatski.`);
      }
    }
    if (problemi.length) throw Object.assign(new Error('Storno odbijen — sledeće stavke bi pale ispod nule:\n' + problemi.join('\n')), { status: 409 });

    await client.query(`
      UPDATE roba_pj SET stanje = stanje - v.kolicina, azurirano = now()
      FROM unnest($1::int[], $2::int[], $3::numeric[]) AS v(roba_id, objekt_id, kolicina)
      WHERE roba_pj.roba_id = v.roba_id AND roba_pj.objekt_id = v.objekt_id
    `, [robaIds, objektIds, kolicine]);

    await client.query(`
      INSERT INTO roba_kretanja (roba_id, objekt_id, tip, kolicina, napomena, korisnik_id, korisnik_ime, presek_batch_id)
      SELECT v.roba_id, v.objekt_id, 'storno-preseka', -v.kolicina, $4, $5, $6, $7
      FROM unnest($1::int[], $2::int[], $3::numeric[]) AS v(roba_id, objekt_id, kolicina)
    `, [robaIds, objektIds, kolicine, `Storno preseka #${batch.id} (${batch.naziv_fajla || ''})`, user.id, user.ime_prezime, batch.id]);

    await client.query(
      `UPDATE presek_batch SET stornirano=true, stornirao_id=$1, stornirao_ime=$2, stornirano_kada=now() WHERE id=$3`,
      [user.id, user.ime_prezime, batch.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, stavki_stornirano: stavke.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/roba/:id/rucni-unos — brza, POJEDINAČNA ispravka stanja/cijene za JEDAN
// artikal (alat "Ručni unos" u Lager listi — za povremena ručna usaglašavanja, između
// dva "velika" preseka). Piše ODMAH (ne čeka grupnu potvrdu kao presek), po jedan artikal
// odjednom.
router.post('/:id/rucni-unos', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može raditi ručna usaglašavanja.' });
  try {
    const objektId = trebaObjekat(req.body.objekt_id);
    if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
    const stanjeNovo = parseFloat(req.body.stanje_novo);
    const cijenaNova = parseFloat(req.body.cijena_nova);
    if (isNaN(stanjeNovo)) return res.status(400).json({ error: 'Unesite ispravno stanje.' }); // negativno JE dozvoljeno (svesno)
    if (isNaN(cijenaNova) || cijenaNova < 0) return res.status(400).json({ error: 'Unesite ispravnu cijenu.' });

    const staraRes = await pool.query('SELECT stanje, cijena FROM roba_pj WHERE roba_id=$1 AND objekt_id=$2', [req.params.id, objektId]);
    if (!staraRes.rows.length) return res.status(404).json({ error: 'Artikal nije pronađen za ovaj PJ.' });
    const stanjeStaro = parseFloat(staraRes.rows[0].stanje);
    const cijenaStara = parseFloat(staraRes.rows[0].cijena);

    await pool.query(
      'UPDATE roba_pj SET stanje=$1, cijena=$2, azurirano=now() WHERE roba_id=$3 AND objekt_id=$4',
      [stanjeNovo, cijenaNova, req.params.id, objektId]
    );

    const razlika = +(stanjeNovo - stanjeStaro).toFixed(3);
    if (Math.abs(razlika) > 0.001) {
      await pool.query(
        `INSERT INTO roba_kretanja (roba_id, objekt_id, tip, kolicina, cijena_stara, cijena_nova, napomena, korisnik_id, korisnik_ime)
         VALUES ($1,$2,'rucni-unos',$3,$4,$5,$6,$7,$8)`,
        [req.params.id, objektId, razlika, cijenaStara, cijenaNova,
         `Ručno usaglašavanje — staro stanje ${stanjeStaro}, novo ${stanjeNovo}`,
         req.session.user.id, req.session.user.ime_prezime]
      );
    }
    res.json({ ok: true, stanje_staro: stanjeStaro, stanje_novo: stanjeNovo, cijena_stara: cijenaStara, cijena_nova: cijenaNova });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/rucni-unos/obrisi-nedavne — brzo brisanje SVIH ručnih unosa TRENUTNOG
// korisnika iz zadnjih N minuta (za ispravku greške pri brzom radu — pogrešna šifra,
// pogrešan broj otkucan u žurbi). Za razliku od "storna" (koji ostavlja trag), ovo BRIŠE
// zapis potpuno — ovo su sitne, česte ispravke tokom rada, ne veliki događaji.
router.post('/rucni-unos/obrisi-nedavne', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može raditi ručna usaglašavanja.' });
  try {
    const minuti = parseInt(req.body.minuti);
    if (!minuti || minuti <= 0 || minuti > 1440) return res.status(400).json({ error: 'Neispravan vremenski period.' });
    const objektId = req.body.objekt_id;
    const user = req.session.user;

    const filterObj = objektId ? 'AND objekt_id=$3' : '';
    const vals = objektId ? [user.id, minuti, objektId] : [user.id, minuti];

    const zapisi = await pool.query(
      `SELECT id, roba_id, objekt_id, kolicina FROM roba_kretanja
       WHERE tip='rucni-unos' AND korisnik_id=$1 AND datum >= now() - ($2 || ' minutes')::interval ${filterObj}`,
      vals
    );
    if (!zapisi.rows.length) return res.json({ ok: true, broj_obrisanih: 0 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const z of zapisi.rows) {
        await client.query(
          'UPDATE roba_pj SET stanje = stanje - $1, azurirano = now() WHERE roba_id=$2 AND objekt_id=$3', // negativno JE dozvoljeno (svesno)
          [z.kolicina, z.roba_id, z.objekt_id]
        );
        await client.query('DELETE FROM roba_kretanja WHERE id=$1', [z.id]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, broj_obrisanih: zapisi.rows.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/roba/:id/debljina — izmjena debljine artikla (mnogi stari artikli je
// nemaju uneseno). Debljina je svojstvo SAMOG artikla (roba tabela), ne po PJ.
router.patch('/:id/debljina', async (req, res) => {
  if (req.session?.user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin.' });
  try {
    const debljina = req.body.debljina_cm === '' || req.body.debljina_cm == null
      ? null : parseFloat(req.body.debljina_cm);
    if (debljina !== null && (isNaN(debljina) || debljina < 0))
      return res.status(400).json({ error: 'Unesite ispravnu debljinu (ili ostavite prazno da je uklonite).' });
    await pool.query('UPDATE roba SET debljina_cm=$1, azurirano=now() WHERE id=$2', [debljina, req.params.id]);
    res.json({ ok: true, debljina_cm: debljina });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/:id/slika — DODAJE novu sliku artikla (bilo koji korisnik koji sme da
// prodaje, ne samo admin — "komercijaliste unose/dropuju slike"). Slika ide na R2, u bazu
// se upisuje SAMO URL (ne sam fajl). Prva ikad dodana slika za taj artikal automatski
// postaje glavna — svaka sledeća se samo dodaje u red, glavna ostaje ista dok se
// eksplicitno ne promijeni.
// POST /api/roba/:id/model3d — otprema FBX (3D model) uz artikal. Jedan model po artiklu
// (nova otprema zamjenjuje prethodni). Fajl ide na R2, u bazu samo URL — isti obrazac kao
// slike, ali BEZ kompresije (3D geometrija se ne može smanjiti kao slika).
// GET /api/roba/:id/model3d — proxy koji ČITA FBX sa R2 i prosleđuje ga pregledaču.
// Potreban jer R2 (kao i ranije kod ponuda) ne šalje CORS zaglavlja, pa pregledač odbija
// da direktno učita fajl sa druge adrese — server nema to ograničenje.
router.get('/:id/model3d', zahtijevaProdaju, async (req, res) => {
  try {
    const r = await pool.query('SELECT model_3d_url FROM roba WHERE id=$1', [req.params.id]);
    const url = r.rows[0]?.model_3d_url;
    if (!url) return res.status(404).json({ error: 'Artikal nema 3D model.' });
    const odgovor = await fetch(url);
    if (!odgovor.ok) return res.status(502).json({ error: `Model nije dostupan na skladištu (${odgovor.status}).` });
    const buffer = Buffer.from(await odgovor.arrayBuffer());
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=3600'); // isti model se često gleda više puta
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Greška pri čitanju modela: ' + err.message });
  }
});

router.post('/:id/model3d', zahtijevaProdaju, upload.single('model'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nema fajla.' });
  const ime = (req.file.originalname || '').toLowerCase();
  if (!ime.endsWith('.fbx')) return res.status(400).json({ error: 'Podržan je samo .fbx format.' });
  try {
    const kljuc = `roba-3d/${req.params.id}-${Date.now()}.fbx`;
    const url = await uploadFile(kljuc, req.file.buffer, 'application/octet-stream');
    await pool.query('UPDATE roba SET model_3d_url=$1, azurirano=now() WHERE id=$2', [url, req.params.id]);
    res.json({ ok: true, model_3d_url: url });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri otpremanju modela: ' + err.message });
  }
});

// DELETE /api/roba/:id/model3d — uklanja vezu ka 3D modelu (undo pogrešnog unosa).
router.delete('/:id/model3d', zahtijevaProdaju, async (req, res) => {
  try {
    await pool.query('UPDATE roba SET model_3d_url=NULL, azurirano=now() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/slika', zahtijevaProdaju, upload.fields([{name:'slika',maxCount:1},{name:'thumb',maxCount:1}]), async (req, res) => {
  const glavniFajl = req.files?.slika?.[0];
  const thumbFajl = req.files?.thumb?.[0];
  if (!glavniFajl) return res.status(400).json({ error: 'Nema fajla.' });
  if (!glavniFajl.mimetype.startsWith('image/'))
    return res.status(400).json({ error: 'Fajl mora biti slika.' });
  try {
    const ekstenzija = (glavniFajl.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const vrijeme = Date.now();
    const url = await uploadFile(`roba-slike/${req.params.id}-${vrijeme}.${ekstenzija}`, glavniFajl.buffer, glavniFajl.mimetype);
    // Mala verzija (~150px) za prikaz u TABELI — ~7x manje podataka nego puna slika.
    // Ako klijent nije poslao thumb (starija verzija stranice), thumb_url ostaje NULL i
    // prikaz pada nazad na punu sliku.
    let thumbUrl = null;
    if (thumbFajl) {
      thumbUrl = await uploadFile(`roba-slike/${req.params.id}-${vrijeme}-t.jpg`, thumbFajl.buffer, 'image/jpeg');
    }

    const postojeceRes = await pool.query('SELECT COUNT(*) AS n, COALESCE(MAX(redosled),-1) AS max_red FROM roba_slike WHERE roba_id=$1', [req.params.id]);
    const jePrva = parseInt(postojeceRes.rows[0].n) === 0;
    const noviRedosled = parseInt(postojeceRes.rows[0].max_red) + 1;

    const ins = await pool.query(
      'INSERT INTO roba_slike (roba_id, url, thumb_url, redosled, glavna) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.params.id, url, thumbUrl, noviRedosled, jePrva]
    );
    res.json({ ok: true, slika_id: ins.rows[0].id, url, thumb_url: thumbUrl, glavna: jePrva });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri otpremanju slike: ' + err.message });
  }
});

// GET /api/roba/:id/slike — lista svih slika za jedan artikal, glavna prva.
router.get('/:id/slike', zahtijevaProdaju, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, url, redosled, glavna FROM roba_slike WHERE roba_id=$1 ORDER BY glavna DESC, redosled ASC',
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/roba/:id/slike/:slikaId/glavna — postavlja jednu sliku kao glavnu (skida
// oznaku sa svih ostalih tog artikla).
router.post('/:id/slike/:slikaId/glavna', zahtijevaProdaju, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE roba_slike SET glavna=false WHERE roba_id=$1', [req.params.id]);
    const r = await client.query('UPDATE roba_slike SET glavna=true WHERE id=$1 AND roba_id=$2 RETURNING id', [req.params.slikaId, req.params.id]);
    if (!r.rows.length) throw Object.assign(new Error('Slika nije pronađena.'), { status: 404 });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/roba/:id/slike/:slikaId — briše jednu sliku. Ako je bila glavna, sledeća
// (po redosledu) automatski postaje glavna, ako postoji.
router.delete('/:id/slike/:slikaId', zahtijevaProdaju, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const obr = await client.query('DELETE FROM roba_slike WHERE id=$1 AND roba_id=$2 RETURNING glavna', [req.params.slikaId, req.params.id]);
    if (!obr.rows.length) throw Object.assign(new Error('Slika nije pronađena.'), { status: 404 });
    if (obr.rows[0].glavna) {
      const sljedeca = await client.query('SELECT id FROM roba_slike WHERE roba_id=$1 ORDER BY redosled ASC LIMIT 1', [req.params.id]);
      if (sljedeca.rows.length) await client.query('UPDATE roba_slike SET glavna=true WHERE id=$1', [sljedeca.rows[0].id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});




module.exports = router;
