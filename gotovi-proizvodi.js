// gotovi-proizvodi.js — SASTAVNICE I RAČUN CIJENE GOTOVOG PROIZVODA
//
// Gotov proizvod ("Sto Pandora") sastoji se od artikala iz lagera. Cijena se RAČUNA:
//     Σ ( cijena_artikla × količina × faktor )
//
// Količina je fiksna (1 postolje) ili se izvodi iz dimenzija proizvoda
// (ploča 1600×900 → 1,440 m²). Kupac plaća NETO površinu — otpad pri rezanju se ne
// naplaćuje, pokriven je faktorom.
//
// Cijene se uvijek povlače SVJEŽE iz lagera tog objekta, nikad se ne prepisuju u
// sastavnicu. Promjena cijene postolja odmah popravi sve stolove koji ga koriste.

const express = require('express');
const router = express.Router();
const pool = require('./db');

/* Čitanje brojeva sa ZAREZOM kao decimalom — isto pravilo kao u pregledaču. */
function broj(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(/,/g, '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function smijeMijenjati(req) {
  const u = req.session?.user;
  return u?.rola === 'admin' || u?.moze_roba_magacin || u?.moze_cijene;
}

router.use((req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  next();
});

/* ── GET / — spisak gotovih proizvoda ─────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT g.*,
              (SELECT COUNT(*) FROM gotov_stavke   s WHERE s.gotov_id = g.id)::int AS broj_stavki,
              (SELECT COUNT(*) FROM gotov_dimenzije d WHERE d.gotov_id = g.id)::int AS broj_dimenzija
       FROM gotovi_proizvodi g
       ${req.query.svi === '1' ? '' : 'WHERE g.aktivan = true'}
       ORDER BY g.naziv`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /nazivi — nazivi iz kolone roba.naziv_gotov ───────────────────────────
   Sastavnica se pravi IZ te kolone: neko u lageru označi postolje i ploču istim
   nazivom, a ovdje se ti artikli sami ponude kao komponente. */
router.get('/nazivi', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.naziv_gotov AS naziv,
              COUNT(*)::int  AS broj_artikala,
              EXISTS(SELECT 1 FROM gotovi_proizvodi g
                     WHERE lower(g.naziv) = lower(r.naziv_gotov)) AS ima_sastavnicu
       FROM roba r
       WHERE r.aktivan = true AND COALESCE(TRIM(r.naziv_gotov), '') <> ''
       GROUP BY r.naziv_gotov ORDER BY r.naziv_gotov`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /:id — jedan proizvod sa stavkama i dimenzijama ───────────────────────── */
router.get('/:id', async (req, res) => {
  try {
    const g = await pool.query('SELECT * FROM gotovi_proizvodi WHERE id=$1', [req.params.id]);
    if (!g.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });

    const s = await pool.query(
      `SELECT st.*, ro.sifra, ro.naziv AS roba_naziv, ro.jed_mjera, ro.grupa
       FROM gotov_stavke st
       LEFT JOIN roba ro ON ro.id = st.roba_id
       WHERE st.gotov_id = $1 ORDER BY st.redosled, st.id`,
      [req.params.id]
    );
    const d = await pool.query(
      'SELECT * FROM gotov_dimenzije WHERE gotov_id=$1 ORDER BY redosled, id',
      [req.params.id]
    );
    res.json({ ...g.rows[0], stavke: s.rows, dimenzije: d.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST / — nov gotov proizvod ────────────────────────────────────────────────
   Ako naziv postoji u roba.naziv_gotov, ti artikli se ODMAH ubace kao stavke —
   sa faktorom 1, da se vidi da još nije podešen. */
router.post('/', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const naziv = String(req.body?.naziv || '').trim();
  if (!naziv) return res.status(400).json({ error: 'Unesite naziv gotovog proizvoda.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = req.session.user;
    const g = await client.query(
      `INSERT INTO gotovi_proizvodi (naziv, grupa, opis, kreirao_id, kreirao_ime)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [naziv, req.body?.grupa || null, req.body?.opis || null, u.id, u.ime_prezime]
    );
    const gotovId = g.rows[0].id;

    // Artikli koji već nose taj naziv → same stavke sastavnice
    const artikli = await client.query(
      `SELECT id, jed_mjera FROM roba
       WHERE aktivan = true AND lower(TRIM(naziv_gotov)) = lower($1) ORDER BY naziv`,
      [naziv]
    );
    let i = 1;
    for (const a of artikli.rows) {
      /* Artikal koji se mjeri u m² je gotovo sigurno PLOČA — njena količina se izvodi
         iz dimenzija stola. Sve ostalo (postolje, okov) ide po komadu. */
      const tip = String(a.jed_mjera || '').toLowerCase().includes('m2') ? 'povrsina' : 'kom';
      await client.query(
        `INSERT INTO gotov_stavke (gotov_id, roba_id, tip_kolicine, kolicina, faktor, redosled)
         VALUES ($1,$2,$3,1,1,$4)`,
        [gotovId, a.id, tip, i++]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ...g.rows[0], dodato_stavki: artikli.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505')
      return res.status(400).json({ error: 'Gotov proizvod sa tim nazivom već postoji.' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ── PATCH /:id ─────────────────────────────────────────────────────────────── */
router.patch('/:id', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const DOZVOLJENA = ['naziv', 'naziv_en', 'naziv_it', 'grupa', 'opis', 'aktivan', 'zaokruzi_na'];
  const sets = [], vals = [];
  let i = 1;
  for (const k of DOZVOLJENA) {
    if (!(k in req.body)) continue;
    sets.push(`${k}=$${i++}`);
    vals.push(k === 'zaokruzi_na' ? broj(req.body[k]) : req.body[k]);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nema polja za izmjenu.' });
  vals.push(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE gotovi_proizvodi SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  try {
    const r = await pool.query('DELETE FROM gotovi_proizvodi WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── STAVKE SASTAVNICE ───────────────────────────────────────────────────────── */
router.post('/:id/stavke', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const { roba_id, opis, tip_kolicine, kolicina, faktor, fiksna_cijena, grupa_izbora } = req.body || {};
  if (!roba_id && !opis)
    return res.status(400).json({ error: 'Izaberite artikal ili upišite opis stavke.' });
  try {
    const n = await pool.query(
      'SELECT COALESCE(MAX(redosled),0)+1 AS r FROM gotov_stavke WHERE gotov_id=$1', [req.params.id]
    );
    const r = await pool.query(
      `INSERT INTO gotov_stavke (gotov_id, roba_id, opis, tip_kolicine, kolicina, faktor, fiksna_cijena, redosled, grupa_izbora)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, roba_id || null, opis || null,
       ['kom','povrsina','duzina'].includes(tip_kolicine) ? tip_kolicine : 'kom',
       broj(kolicina) || 1, broj(faktor) || 1,
       fiksna_cijena != null && fiksna_cijena !== '' ? broj(fiksna_cijena) : null,
       n.rows[0].r, String(grupa_izbora || '').trim() || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/stavka/:sid', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const DOZVOLJENA = ['roba_id', 'opis', 'tip_kolicine', 'kolicina', 'faktor', 'fiksna_cijena', 'redosled', 'grupa_izbora', 'podrazumijevana'];
  const sets = [], vals = [];
  let i = 1;
  for (const k of DOZVOLJENA) {
    if (!(k in req.body)) continue;
    let v = req.body[k];
    if (['kolicina', 'faktor', 'fiksna_cijena'].includes(k)) v = (v === '' || v == null) ? null : broj(v);
    sets.push(`${k}=$${i++}`);
    vals.push(v);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nema polja za izmjenu.' });
  vals.push(req.params.sid);
  try {
    const r = await pool.query(`UPDATE gotov_stavke SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Stavka nije pronađena.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/stavka/:sid', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  try {
    const r = await pool.query('DELETE FROM gotov_stavke WHERE id=$1 RETURNING id', [req.params.sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Stavka nije pronađena.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── DIMENZIJE ───────────────────────────────────────────────────────────────── */
router.post('/:id/dimenzije', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const sirina = broj(req.body?.sirina), visina = broj(req.body?.visina);
  if (sirina <= 0 || visina <= 0)
    return res.status(400).json({ error: 'Unesite širinu i visinu (mm).' });
  // Mjere su u MILIMETRIMA — štiti od unosa u centimetrima (160 umjesto 1600)
  if (sirina < 100 || visina < 100)
    return res.status(400).json({
      error: `Mjere se unose u MILIMETRIMA (npr. 1600 × 900). Uneseno: ${sirina} × ${visina}.`,
    });
  try {
    const n = await pool.query(
      'SELECT COALESCE(MAX(redosled),0)+1 AS r FROM gotov_dimenzije WHERE gotov_id=$1', [req.params.id]
    );
    const r = await pool.query(
      `INSERT INTO gotov_dimenzije (gotov_id, sirina, visina, naziv, redosled)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, sirina, visina, req.body?.naziv || null, n.rows[0].r]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/dimenzija/:did', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  try {
    const r = await pool.query('DELETE FROM gotov_dimenzije WHERE id=$1 RETURNING id', [req.params.did]);
    if (!r.rows.length) return res.status(404).json({ error: 'Dimenzija nije pronađena.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /:id/cijena — RAČUN ───────────────────────────────────────────────────
   Vraća cijenu za svaku dimenziju, sa razradom po komponenti.
   Parametri: objekt_id (čije cijene), tip_kupca_id (koji popust).            */
router.get('/:id/cijena', async (req, res) => {
  const objektId = parseInt(req.query.objekt_id) || null;
  const tipKupcaId = parseInt(req.query.tip_kupca_id) || null;
  try {
    const g = await pool.query('SELECT * FROM gotovi_proizvodi WHERE id=$1', [req.params.id]);
    if (!g.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    const proizvod = g.rows[0];

    /* Cijene se povlače SVJEŽE iz lagera — nikad se ne prepisuju u sastavnicu.
       Promjena cijene postolja odmah popravi sve stolove koji ga koriste. */
    const s = await pool.query(
      `SELECT st.*, ro.sifra, ro.naziv AS roba_naziv, ro.jed_mjera,
              rp.cijena AS cijena_lager, po.valuta
       FROM gotov_stavke st
       LEFT JOIN roba ro ON ro.id = st.roba_id
       LEFT JOIN roba_pj rp ON rp.roba_id = st.roba_id AND rp.objekt_id = $2
       LEFT JOIN prodajni_objekti po ON po.id = $2
       WHERE st.gotov_id = $1 ORDER BY st.redosled, st.id`,
      [req.params.id, objektId]
    );
    const d = await pool.query(
      'SELECT * FROM gotov_dimenzije WHERE gotov_id=$1 ORDER BY redosled, id', [req.params.id]
    );

    // Popust po tipu kupca — koristi se postojeći mehanizam iz modula Cijene
    let popustPosto = 0, tipNaziv = null;
    if (tipKupcaId) {
      const t = await pool.query('SELECT naziv, popust_posto FROM tipovi_kupaca WHERE id=$1', [tipKupcaId]);
      if (t.rows.length) { popustPosto = parseFloat(t.rows[0].popust_posto) || 0; tipNaziv = t.rows[0].naziv; }
    }

    const zaokruzi = parseFloat(proizvod.zaokruzi_na) || 0;
    const zaokruziNa = v => zaokruzi > 0 ? Math.ceil(v / zaokruzi) * zaokruzi : v;

    /* Stavke se dijele na OBAVEZNE i GRUPE IZBORA.
       Obavezne ulaze uvijek. Iz svake grupe izbora ulazi TACNO JEDNA — inače bi se
       sabrala sva postolja odjednom, što bi dalo besmislenu cijenu. */
    const obavezne = s.rows.filter(x => !x.grupa_izbora);
    const grupe = {};
    for (const x of s.rows) {
      if (!x.grupa_izbora) continue;
      (grupe[x.grupa_izbora] = grupe[x.grupa_izbora] || []).push(x);
    }
    const imenaGrupa = Object.keys(grupe);

    /* Sve kombinacije izbora. Sa 3 postolja i 4 ploče to je 12 varijanti po dimenziji.
       Granica od 200 stiti od slucaja gdje bi neko dodao previse grupa i srusio prikaz. */
    function kombinacije() {
      let out = [[]];
      for (const g of imenaGrupa) {
        const nove = [];
        for (const dosad of out) for (const st of grupe[g]) nove.push([...dosad, st]);
        out = nove;
        if (out.length > 200) return out.slice(0, 200);
      }
      return out;
    }

    /* Granica stiti od eksplozije: 5 grupa po 6 stavki = 7776 kombinacija.
       Toliko niko ne cita, a odgovor bi bio ogroman. */
    const MAX_KOMBINACIJA = 200;
    const sveKombinacije = imenaGrupa.length ? kombinacije() : [[]];
    const kombinacijeZaRacun = sveKombinacije.slice(0, MAX_KOMBINACIJA);

    function racunaj(dim, izabrane) {
      const m2 = dim ? (parseFloat(dim.sirina) * parseFloat(dim.visina)) / 1e6 : 0;
      const m1 = dim ? (2 * (parseFloat(dim.sirina) + parseFloat(dim.visina))) / 1000 : 0;
      const razrada = [];
      let osnovica = 0, nepotpuno = false;

      for (const st of [...obavezne, ...izabrane]) {
        const cijena = st.fiksna_cijena != null
          ? parseFloat(st.fiksna_cijena)
          : (st.cijena_lager != null ? parseFloat(st.cijena_lager) : null);
        if (cijena == null) nepotpuno = true;

        const mnozilac = parseFloat(st.kolicina) || 1;
        const kol = st.tip_kolicine === 'povrsina' ? m2 * mnozilac
                  : st.tip_kolicine === 'duzina'   ? m1 * mnozilac
                  : mnozilac;
        const faktor = parseFloat(st.faktor) || 1;
        const iznos = (cijena || 0) * kol * faktor;
        osnovica += iznos;
        razrada.push({
          stavka_id: st.id,
          grupa_izbora: st.grupa_izbora || null,
          naziv: st.roba_naziv || st.opis, sifra: st.sifra,
          kolicina: +kol.toFixed(3),
          jedinica: st.tip_kolicine === 'povrsina' ? 'm²' : st.tip_kolicine === 'duzina' ? 'm¹' : (st.jed_mjera || 'kom'),
          cijena: cijena != null ? +cijena.toFixed(2) : null,
          faktor, iznos: +iznos.toFixed(2), bez_cijene: cijena == null,
        });
      }

      /* Faktor pravi CJENOVNIK, popust je pregovor — dva odvojena sloja.
         Kupcu se prikazuje i puna cijena i usteda, jer to i jeste smisao popusta. */
      const popust = osnovica * (popustPosto / 100);
      const konacna = zaokruziNa(osnovica - popust);
      return {
        dimenzija_id: dim?.id || null,
        sirina: dim ? +dim.sirina : null,
        visina: dim ? +dim.visina : null,
        dimenzija: dim ? (dim.naziv || `${Math.round(dim.sirina)}×${Math.round(dim.visina)}`) : null,
        izbor: izabrane.map(x => ({
          grupa: x.grupa_izbora, stavka_id: x.id,
          naziv: x.roba_naziv || x.opis, sifra: x.sifra,
        })),
        povrsina_m2: +m2.toFixed(3),
        cijena_cjenovnik: +osnovica.toFixed(2),
        popust_posto: popustPosto,
        popust: +popust.toFixed(2),
        cijena: +konacna.toFixed(2),
        nepotpuno, razrada,
      };
    }

    const dimenzije = d.rows.length ? d.rows : [null];
    const redovi = [];
    for (const dim of dimenzije) {
      for (const komb of kombinacijeZaRacun) redovi.push(racunaj(dim, komb));
    }

    res.json({
      id: proizvod.id, naziv: proizvod.naziv,
      valuta: s.rows[0]?.valuta || 'KM',
      tip_kupca: tipNaziv,
      zaokruzi_na: zaokruzi,
      grupe_izbora: imenaGrupa.map(g => ({
        naziv: g,
        opcije: grupe[g].map(x => ({ stavka_id: x.id, naziv: x.roba_naziv || x.opis, sifra: x.sifra })),
      })),
      grupe_izbora: imenaGrupa.map(g => ({
        naziv: g,
        opcije: grupe[g].map(x => ({
          stavka_id: x.id, naziv: x.roba_naziv || x.opis, sifra: x.sifra,
          podrazumijevana: x.podrazumijevana,
        })),
      })),
      broj_kombinacija: sveKombinacije.length * dimenzije.length,
      // Kad kombinacija ima previse, vraca se prvih 200 — vise od toga niko ne cita
      skraceno: sveKombinacije.length > MAX_KOMBINACIJA,
      cijene: redovi,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
