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

/* ── OBLICI ────────────────────────────────────────────────────────────────────────
   Preuzeto iz modula Ponude (SHAPES), da se isti oblici koriste svuda — ponuda, nalog
   i gotov proizvod govore istim jezikom.
   Mjere se cuvaju kao {A: 2800, B: 600, ...}, jer svaki oblik ima svoj skup. */
/* Mjere koje sastojak moze da DEFINISE. Postolje odredjuje visinu, ploca sirinu i
   duzinu, kod klupica debljinu. Vrijednosti se unose PO PROIZVODU — nisu svi stolovi
   iste visine (trpezarijski i klub sto se razlikuju). */
/* Oblici se dijele po tome KOJE MJERE traze:
     kruzni      → samo precnik
     pravougaoni → duzina × sirina (maksimalne, jer se elipsa i bacva upisuju u okvir) */
const KRUZNI = ['KRUG'];
/* Oblici STOLOVA — samo oni se prihvataju kao alternativa jedan drugom.
   L, U, V i G su oblici kuhinjskih ploca; za sto nemaju smisla. */
const STOLOVI = ['PRAV', 'KVAD', 'OVAL', 'BACVA', 'ZAOB'];
const PRAVOUGAONI = ['PRAV', 'KVAD', 'OVAL', 'BACVA', 'ZAOB', 'I', 'L', 'U', 'V', 'N', 'G'];

const MJERE = {
  duzina:   { lbl: 'Dužina',   kratko: 'D' },
  sirina:   { lbl: 'Širina',   kratko: 'Š' },
  visina:   { lbl: 'Visina',   kratko: 'V' },
  debljina: { lbl: 'Debljina', kratko: 'd' },
  precnik:  { lbl: 'Prečnik',  kratko: 'Ø' },
};

const OBLICI = {
  /* ── OBLICI STOLOVA ──
     Racun povrsine se STVARNO razlikuje: ovalni sto 1800×1000 ima 1,414 m², a
     pravougaoni iste mjere 1,800 m² — 21% manje materijala. Da se svi racunaju kao
     pravougaoni, cijena bi bila znatno veca od stvarne. */
  PRAV:  { lbl: 'Pravougaoni sto',     dims: ['A','B'],     grupa: 'sto' },
  KVAD:  { lbl: 'Kvadratni sto',       dims: ['A'],         grupa: 'sto' },
  KRUG:  { lbl: 'Okrugli sto',         dims: ['D'],         grupa: 'sto' },
  OVAL:  { lbl: 'Ovalni sto',          dims: ['A','B'],     grupa: 'sto' },
  BACVA: { lbl: 'Bačvasti sto',        dims: ['A','B'],     grupa: 'sto' },
  ZAOB:  { lbl: 'Zaobljeni uglovi',    dims: ['A','B','R'], grupa: 'sto' },

  /* ── OBLICI PLOCA (iz modula Ponude) ── */
  I:  { lbl: 'Pravougli',   dims: ['A','B'] },
  L:  { lbl: 'L oblik',     dims: ['A','C','D','E'] },
  U:  { lbl: 'U oblik',     dims: ['A','B','C','D','E','F'] },
  V:  { lbl: 'V oblik',     dims: ['A','B','C','D','F','G'] },
  N:  { lbl: 'Nepravilan',  dims: ['A','B','C'] },
  G:  { lbl: 'G oblik',     dims: ['A','B','C','D','E','F','G','H'] },
  KRUG: { lbl: 'Okrugli',   dims: ['D'] },     // D = precnik
};

/* Povrsina i obim po obliku. Mjere su u mm, rezultat u m² i m¹.
   Kod slozenih oblika (L, U, V, G) povrsina je zbir pravougaonih krakova — isti nacin
   kako se i rezu, pa se poklapa sa stvarnim utroskom. */
function mjereOblika(oblik, m) {
  const v = k => parseFloat(m?.[k]) || 0;
  let mm2 = 0, mm1 = 0;

  switch (oblik) {
    case 'PRAV':
      mm2 = v('A') * v('B');
      mm1 = 2 * (v('A') + v('B'));
      break;
    case 'KVAD':
      mm2 = v('A') * v('A');
      mm1 = 4 * v('A');
      break;
    case 'OVAL': {
      // Elipsa: π·a·b/4 gdje su a i b puni precnici
      mm2 = Math.PI * v('A') * v('B') / 4;
      // Ramanujanova pribliznost za obim elipse — tacna do promila
      const a = v('A') / 2, b = v('B') / 2;
      const h = Math.pow(a - b, 2) / Math.pow(a + b, 2);
      mm1 = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
      break;
    }
    case 'BACVA':
      /* Pravougaonik sa polukruznim krajevima: puna povrsina minus sto "odsijeku"
         zaobljenja. Krajevi su polukrugovi precnika B. */
      mm2 = v('A') * v('B') - (4 - Math.PI) * Math.pow(v('B') / 2, 2);
      mm1 = 2 * (v('A') - v('B')) + Math.PI * v('B');
      break;
    case 'ZAOB':
      // Cetiri zaobljena ugla radijusa R zajedno "odsijeku" (4−π)·R²
      mm2 = v('A') * v('B') - (4 - Math.PI) * Math.pow(v('R'), 2);
      mm1 = 2 * (v('A') + v('B')) - 8 * v('R') + 2 * Math.PI * v('R');
      break;
    case 'KRUG': {
      const r = v('D') / 2;
      mm2 = Math.PI * r * r;
      mm1 = Math.PI * v('D');
      break;
    }
    case 'L':
      // Gornji krak A×C + donji krak E×D
      mm2 = v('A') * v('C') + v('E') * v('D');
      mm1 = 2 * (v('A') + v('C') + v('E') + v('D'));
      break;
    case 'U':
      // Gornji A×D + lijevi B×E + desni C×F
      mm2 = v('A') * v('D') + v('B') * v('E') + v('C') * v('F');
      mm1 = 2 * (v('A') + v('B') + v('C'));
      break;
    case 'V':
      // Gornji A×C + donji (B−C)×D, kosina se ne oduzima — rez ide po okviru
      mm2 = v('A') * v('C') + Math.max(0, v('B') - v('C')) * v('D');
      mm1 = 2 * (v('A') + v('B'));
      break;
    case 'G':
      // Vanjski okvir A×B minus unutrasnji izrez G×H
      mm2 = Math.max(0, v('A') * v('B') - v('G') * v('H'));
      mm1 = 2 * (v('A') + v('B'));
      break;
    case 'N':
      // Trapez: (lijeva + desna visina) / 2 × donja duzina
      mm2 = ((v('B') + v('C')) / 2) * v('A');
      mm1 = 2 * (v('A') + Math.max(v('B'), v('C')));
      break;
    default:  // 'I' — pravougli
      mm2 = v('A') * v('B');
      mm1 = 2 * (v('A') + v('B'));
  }
  return { m2: mm2 / 1e6, m1: mm1 / 1000 };
}

/* Kratak opis dimenzije za prikaz: "2800×600", "Ø1200", "L 3000/600/600/1000" */
function opisOblika(oblik, m) {
  const v = k => Math.round(parseFloat(m?.[k]) || 0);
  /* Imenovane mjere: "1600×900" ili "1600×900×720" kad je visina unesena. */
  if (m?.duzina || m?.sirina) {
    const d = [v('duzina'), v('sirina')].filter(Boolean).join('×');
    const dodaci = [];
    if (m.visina) dodaci.push(`H${v('visina')}`);
    if (m.debljina) dodaci.push(`${v('debljina')}mm`);
    return d + (dodaci.length ? ' · ' + dodaci.join(' · ') : '');
  }
  if (m?.precnik) return `Ø${v('precnik')}` + (m.visina ? ` · H${v('visina')}` : '');
  if (oblik === 'KRUG') return `Ø${v('D')}`;
  if (oblik === 'KVAD') return `${v('A')}×${v('A')}`;
  if (oblik === 'OVAL') return `⬭ ${v('A')}×${v('B')}`;
  if (oblik === 'BACVA') return `▢ ${v('A')}×${v('B')}`;
  if (oblik === 'ZAOB') return `${v('A')}×${v('B')} r${v('R')}`;
  if (oblik === 'PRAV' || oblik === 'I' || !oblik) return `${v('A')}×${v('B')}`;
  const d = (OBLICI[oblik]?.dims || []).map(v).filter(Boolean).join('/');
  return `${oblik} ${d}`;
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
      /* Mjera moze doci sa DVA mjesta: dimenzija proizvoda (gotov_dimenzije) ili
         mjera dijela na samoj komponenti (sirina_kom/visina_kom). Ranije se brojalo
         samo prvo, pa je proizvod sa mjerom dijela pogresno bio oznacen kao "bez mjere". */
      `SELECT g.*,
              (SELECT COUNT(*) FROM gotov_stavke   s WHERE s.gotov_id = g.id)::int AS broj_stavki,
              (SELECT COUNT(*) FROM gotov_dimenzije d WHERE d.gotov_id = g.id)::int AS broj_dimenzija,
              EXISTS(SELECT 1 FROM gotov_stavke s
                     WHERE s.gotov_id = g.id
                       AND s.tip_kolicine IN ('povrsina','duzina')
                       AND (s.sirina_kom IS NOT NULL OR s.visina_kom IS NOT NULL)) AS ima_mjeru_dijela,
              /* Proizvod je mjerljiv ako ima dimenziju ILI mjeru dijela ILI su mu sve
                 stavke komadne — tad mjera uopste ne treba. */
              (
                EXISTS(SELECT 1 FROM gotov_dimenzije d WHERE d.gotov_id = g.id)
                OR EXISTS(SELECT 1 FROM gotov_stavke s WHERE s.gotov_id = g.id
                          AND s.tip_kolicine IN ('povrsina','duzina')
                          AND (s.sirina_kom IS NOT NULL OR s.visina_kom IS NOT NULL))
                OR NOT EXISTS(SELECT 1 FROM gotov_stavke s WHERE s.gotov_id = g.id
                              AND s.tip_kolicine IN ('povrsina','duzina'))
              ) AS mjerljiv
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
// GET /oblici — spisak oblika sa mjerama koje traze (za obrazac u prikazu)
/* ═══ GRUPE PROIZVODA I SASTOJCI ═══════════════════════════════════════════════════
   Nivo iznad sastavnice. Grupa ("Sto") kaze OD CEGA se sastoji i sta smije u svaki
   sastojak — pa se sastavnica sama postavi, a izbor artikla je vec suzen.
   Bez toga bi se za svaki nov sto iznova kucalo sta ide u njega. */

router.get('/grupe', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT g.*,
              (SELECT COUNT(*) FROM grupa_sastojci s WHERE s.grupa_id = g.id)::int AS broj_sastojaka,
              (SELECT COUNT(*) FROM gotovi_proizvodi p WHERE p.grupa_proizvoda_id = g.id)::int AS broj_proizvoda
       FROM grupe_proizvoda g
       ${req.query.svi === '1' ? '' : 'WHERE g.aktivan = true'}
       ORDER BY g.redosled, g.naziv`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/grupe/:id', async (req, res) => {
  try {
    const g = await pool.query('SELECT * FROM grupe_proizvoda WHERE id=$1', [req.params.id]);
    if (!g.rows.length) return res.status(404).json({ error: 'Grupa nije pronađena.' });
    const s = await pool.query(
      'SELECT * FROM grupa_sastojci WHERE grupa_id=$1 ORDER BY redni_broj, id', [req.params.id]
    );
    res.json({ ...g.rows[0], sastojci: s.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/grupe', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const naziv = String(req.body?.naziv || '').trim();
  if (!naziv) return res.status(400).json({ error: 'Unesite naziv grupe proizvoda.' });
  try {
    const u = req.session.user;
    const r = await pool.query(
      `INSERT INTO grupe_proizvoda (naziv, oblik, opis, kreirao_id, kreirao_ime)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [naziv, OBLICI[req.body?.oblik] ? req.body.oblik : 'PRAV',
       req.body?.opis || null, u.id, u.ime_prezime]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Grupa sa tim nazivom već postoji.' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/grupe/:id', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const DOZ = ['naziv', 'oblik', 'opis', 'aktivan', 'redosled'];
  const sets = [], vals = [];
  let i = 1;
  for (const k of DOZ) {
    if (!(k in req.body)) continue;
    if (k === 'oblik' && !OBLICI[req.body[k]]) continue;
    sets.push(`${k}=$${i++}`); vals.push(req.body[k]);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nema polja za izmjenu.' });
  vals.push(req.params.id);
  try {
    const r = await pool.query(`UPDATE grupe_proizvoda SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Grupa nije pronađena.' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/grupe/:id', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  try {
    // Grupa se ne brise ako je neki proizvod koristi — inace bi ostao bez strukture
    const p = await pool.query(
      'SELECT COUNT(*)::int AS n FROM gotovi_proizvodi WHERE grupa_proizvoda_id=$1', [req.params.id]
    );
    if (p.rows[0].n > 0)
      return res.status(400).json({
        error: `Grupu koristi ${p.rows[0].n} ${p.rows[0].n === 1 ? 'proizvod' : 'proizvoda'} — prvo ih premjesti ili obriši.`,
      });
    const r = await pool.query('DELETE FROM grupe_proizvoda WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Grupa nije pronađena.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── SASTOJCI ────────────────────────────────────────────────────────────────── */
router.post('/grupe/:id/sastojci', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const naziv = String(req.body?.naziv || '').trim();
  if (!naziv) return res.status(400).json({ error: 'Unesite naziv sastojka (npr. „ploča").' });
  try {
    const n = await pool.query(
      'SELECT COALESCE(MAX(redni_broj),0)+1 AS r FROM grupa_sastojci WHERE grupa_id=$1', [req.params.id]
    );
    const grupe = Array.isArray(req.body?.dozvoljene_grupe)
      ? req.body.dozvoljene_grupe.map(x => String(x).trim()).filter(Boolean) : null;
    const r = await pool.query(
      `INSERT INTO grupa_sastojci
         (grupa_id, redni_broj, naziv, dozvoljene_grupe, tip_kolicine,
          min_debljina, max_debljina, samo_na_stanju, obavezan, napomena)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.id, n.rows[0].r, naziv,
       grupe && grupe.length ? grupe : null,
       ['kom','povrsina','duzina'].includes(req.body?.tip_kolicine) ? req.body.tip_kolicine : 'kom',
       req.body?.min_debljina ? broj(req.body.min_debljina) : null,
       req.body?.max_debljina ? broj(req.body.max_debljina) : null,
       req.body?.samo_na_stanju === true,
       req.body?.obavezan === true,
       req.body?.napomena || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/sastojak/:sid', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const DOZ = ['naziv','dozvoljene_grupe','tip_kolicine','min_debljina','max_debljina',
               'samo_na_stanju','obavezan','napomena','redni_broj','definise'];
  const sets = [], vals = [];
  let i = 1;
  for (const k of DOZ) {
    if (!(k in req.body)) continue;
    let v = req.body[k];
    if (['min_debljina','max_debljina'].includes(k)) v = (v === '' || v == null) ? null : broj(v);
    if (k === 'definise') {
      v = Array.isArray(v) ? v.filter(x => MJERE[x]) : null;
      if (v && !v.length) v = null;
    }
    if (k === 'dozvoljene_grupe') {
      v = Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : null;
      if (v && !v.length) v = null;
    }
    sets.push(`${k}=$${i++}`); vals.push(v);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nema polja za izmjenu.' });
  vals.push(req.params.sid);
  try {
    const r = await pool.query(`UPDATE grupa_sastojci SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Sastojak nije pronađen.' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/sastojak/:sid', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  try {
    const r = await pool.query('DELETE FROM grupa_sastojci WHERE id=$1 RETURNING id', [req.params.sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Sastojak nije pronađen.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /sastojak/:sid/artikli — artikli koji SMIJU u ovaj sastojak ──────────────
   Ogranicenja se primjenjuju na SERVERU, ne u prikazu: za plocu stola nema smisla
   nuditi table deblje od 3 cm, pa se i ne salju. */
router.get('/sastojak/:sid/artikli', async (req, res) => {
  const objektId = parseInt(req.query.objekt_id) || null;
  try {
    const s = await pool.query('SELECT * FROM grupa_sastojci WHERE id=$1', [req.params.sid]);
    if (!s.rows.length) return res.status(404).json({ error: 'Sastojak nije pronađen.' });
    const sast = s.rows[0];

    const uslovi = ['r.aktivan = true'];
    const vals = [objektId];
    if (sast.dozvoljene_grupe?.length) {
      vals.push(sast.dozvoljene_grupe);
      uslovi.push(`LOWER(TRIM(COALESCE(r.grupa,''))) = ANY(SELECT LOWER(TRIM(x)) FROM unnest($${vals.length}::text[]) x)`);
    }
    if (sast.min_debljina != null) { vals.push(sast.min_debljina); uslovi.push(`r.debljina_cm >= $${vals.length}`); }
    if (sast.max_debljina != null) { vals.push(sast.max_debljina); uslovi.push(`r.debljina_cm <= $${vals.length}`); }
    if (sast.samo_na_stanju) uslovi.push('COALESCE(rp.stanje,0) > 0');

    const r = await pool.query(
      `SELECT r.id, r.sifra, r.naziv, r.grupa, r.jed_mjera, r.debljina_cm,
              r.std_sirina, r.std_visina, r.naziv_gotov,
              rp.cijena, rp.stanje,
              (SELECT COALESCE(thumb_url, url) FROM roba_slike WHERE roba_id=r.id AND glavna=true LIMIT 1) AS glavna_slika,
              (SELECT COUNT(*) FROM roba_slike WHERE roba_id=r.id)::int AS broj_slika
       FROM roba r
       LEFT JOIN roba_pj rp ON rp.roba_id = r.id AND rp.objekt_id = $1
       WHERE ${uslovi.join(' AND ')}
       ORDER BY r.grupa, r.naziv LIMIT 500`,
      vals
    );
    res.json({
      sastojak: sast,
      artikli: r.rows,
      // Da prikaz moze reci ZASTO je spisak kratak
      ogranicenja: {
        grupe: sast.dozvoljene_grupe || null,
        min_debljina: sast.min_debljina, max_debljina: sast.max_debljina,
        samo_na_stanju: sast.samo_na_stanju,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /mjere — spisak mjera koje sastojak moze definisati
router.get('/mjere', (req, res) => {
  res.json(Object.entries(MJERE).map(([id, m]) => ({ id, ...m })));
});

router.get('/oblici', (req, res) => {
  res.json({
    oblici: Object.entries(OBLICI).map(([id, o]) => ({
      id, lbl: o.lbl, dims: o.dims, kruzni: KRUZNI.includes(id),
    })),
    kruzni: KRUZNI, pravougaoni: PRAVOUGAONI,
  });
});

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

    /* Uz komponentu se vraca i STANJE i CIJENA iz lagera — komercijalista tako odmah
       vidi ima li materijala i po kojoj cijeni, pa zna da li da ide sa nizom ili visom. */
    const objektId = parseInt(req.query.objekt_id) || null;
    const s = await pool.query(
      /* Uz komponentu se vraca i SLIKA, plus podatak IMA LI oznacenu glavnu i sliku
         gotovog proizvoda — da se u sastavnici odmah vidi sta jos treba oznaciti,
         umjesto da se ide artikal po artikal kroz lager. */
      /* Iz lager liste se prenosi SVE osim kolone "Ukupno" — ona ovdje nema smisla,
         jer se u sastavnici racuna cijena po komponenti, ne vrijednost zaliha. */
      `SELECT st.*, ro.sifra, ro.naziv AS roba_naziv, ro.jed_mjera, ro.grupa,
              ro.debljina_cm, ro.std_sirina, ro.std_visina, ro.naziv_gotov,
              ro.moguci_oblici,
              sa.naziv AS sastojak_naziv, sa.redni_broj AS sastojak_red,
              sa.dozvoljene_grupe, sa.max_debljina, sa.obavezan,
              rp.cijena AS cijena_lager, rp.stanje AS stanje_lager,
              (SELECT COALESCE(thumb_url, url) FROM roba_slike
               WHERE roba_id = ro.id AND glavna = true LIMIT 1)          AS slika_glavna,
              (SELECT COALESCE(thumb_url, url) FROM roba_slike
               WHERE roba_id = ro.id AND gotov_proizvod = true LIMIT 1)  AS slika_gotov,
              (SELECT COUNT(*) FROM roba_slike WHERE roba_id = ro.id)::int AS broj_slika
       FROM gotov_stavke st
       LEFT JOIN roba ro ON ro.id = st.roba_id
       LEFT JOIN roba_pj rp ON rp.roba_id = st.roba_id AND rp.objekt_id = $2
       LEFT JOIN grupa_sastojci sa ON sa.id = st.sastojak_id
       WHERE st.gotov_id = $1 ORDER BY COALESCE(sa.redni_broj, 99), st.redosled, st.id`,
      [req.params.id, objektId]
    );
    const d = await pool.query(
      'SELECT * FROM gotov_dimenzije WHERE gotov_id=$1 ORDER BY redosled, id',
      [req.params.id]
    );
    /* Sastojci grupe idu uz proizvod — prikaz iz njih crta sekcije, i one prazne. */
    let sastojciGrupe = [];
    if (g.rows[0].grupa_proizvoda_id) {
      const sg = await pool.query(
        'SELECT * FROM grupa_sastojci WHERE grupa_id=$1 ORDER BY redni_broj, id',
        [g.rows[0].grupa_proizvoda_id]
      );
      sastojciGrupe = sg.rows;

      /* POPRAVKA: stavke dodate prije nego sto je veza sa sastojkom proradila imaju
         sastojak_id prazan, pa se prikazuju kao zaseban odjeljak — ispada da je isti
         sastojak dvaput. Ovdje se povezuju po nazivu, jednom, tiho. */
      const bezVeze = s.rows.filter(x => !x.sastojak_id && x.grupa_izbora);
      for (const st of bezVeze) {
        const ime = String(st.grupa_izbora).replace(/^pod\s*\d+\s*·\s*/i, '').trim().toLowerCase();
        const nadjen = sastojciGrupe.find(x => String(x.naziv).trim().toLowerCase() === ime);
        if (!nadjen) continue;
        await pool.query('UPDATE gotov_stavke SET sastojak_id=$1, grupa_izbora=$2 WHERE id=$3',
          [nadjen.id, nadjen.naziv, st.id]).catch(() => {});
        st.sastojak_id = nadjen.id;
        st.grupa_izbora = nadjen.naziv;
      }
    }
    res.json({ ...g.rows[0], stavke: s.rows, dimenzije: d.rows, sastojci_grupe: sastojciGrupe });
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
    const grupaId = parseInt(req.body?.grupa_proizvoda_id) || null;
    const g = await client.query(
      `INSERT INTO gotovi_proizvodi (naziv, grupa, opis, grupa_proizvoda_id, kreirao_id, kreirao_ime)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [naziv, req.body?.grupa || null, req.body?.opis || null, grupaId, u.id, u.ime_prezime]
    );
    const gotovId = g.rows[0].id;

    /* Ako je proizvod vezan za GRUPU, njeni sastojci se odmah prenose kao prazne
       stavke — tako se sastavnica sama postavi i ne pamti se sta ide u sto. */
    let prenesenoSastojaka = 0;
    if (grupaId) {
      const sast = await client.query(
        'SELECT * FROM grupa_sastojci WHERE grupa_id=$1 ORDER BY redni_broj, id', [grupaId]
      );
      /* Prazne stavke se NE prave. Ranije se za svaki sastojak upisivao prazan red sa
         opisom "(prazno — dodaj artikal)", koji se nije mogao ni urediti ni obrisati.
         Umjesto toga prikaz crta sekcije iz same grupe, pa su prazne dok se ne popune. */
      prenesenoSastojaka = sast.rows.length;
    }

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
    res.status(201).json({ ...g.rows[0], dodato_stavki: artikli.rows.length, sastojaka: prenesenoSastojaka });
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
  const DOZVOLJENA = ['naziv', 'naziv_en', 'naziv_it', 'grupa', 'opis', 'aktivan', 'zaokruzi_na', 'slika_url', 'slika_roba_id', 'grupa_proizvoda_id', 'spreman_za_katalog'];
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
      `INSERT INTO gotov_stavke (gotov_id, roba_id, opis, tip_kolicine, kolicina, faktor, fiksna_cijena, redosled, grupa_izbora, sastojak_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.id, roba_id || null, opis || null,
       ['kom','povrsina','duzina'].includes(tip_kolicine) ? tip_kolicine : 'kom',
       broj(kolicina) || 1, broj(faktor) || 1,
       fiksna_cijena != null && fiksna_cijena !== '' ? broj(fiksna_cijena) : null,
       n.rows[0].r, String(grupa_izbora || '').trim() || null,
       parseInt(req.body?.sastojak_id) || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/stavka/:sid', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const DOZVOLJENA = ['roba_id', 'opis', 'tip_kolicine', 'kolicina', 'faktor', 'fiksna_cijena', 'marza_posto', 'sirina_kom', 'visina_kom', 'redosled', 'grupa_izbora', 'podrazumijevana', 'sastojak_id'];
  const sets = [], vals = [];
  let i = 1;
  for (const k of DOZVOLJENA) {
    if (!(k in req.body)) continue;
    let v = req.body[k];
    if (['kolicina','faktor','fiksna_cijena','marza_posto','sirina_kom','visina_kom'].includes(k)) v = (v === '' || v == null) ? null : broj(v);
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
  /* Dva oblika: pravougaonik (sirina × visina) i krug (precnik). Okrugli sto se ne
     moze opisati kroz sirinu i visinu — povrsina mu je πr², ne s×v. */
  /* Nov zapis: oblik iz spiska (I, L, U, V, N, G, KRUG) i mjere {A, B, ...}.
     Stari (sirina/visina) se i dalje prima, da ranije dimenzije nastave da rade. */
  /* NOV zapis: imenovane mjere {duzina, sirina, visina, debljina} — sastojci kazu
     koje traze, pa se unosi samo ono sto proizvod stvarno ima. */
  if (req.body?.mjere && !Array.isArray(req.body.mjere) &&
      Object.keys(req.body.mjere).some(k => MJERE[k])) {
    const m = req.body.mjere;
    const cisto = {};
    for (const k of Object.keys(MJERE)) if (broj(m[k]) > 0) cisto[k] = broj(m[k]);
    const ob = OBLICI[req.body?.oblik] ? req.body.oblik : 'PRAV';
    if (KRUZNI.includes(ob)) {
      if (!cisto.precnik) return res.status(400).json({ error: 'Za okrugli oblik unesite prečnik.' });
    } else if (!cisto.duzina || !cisto.sirina) {
      return res.status(400).json({ error: 'Unesite dužinu i širinu.' });
    }
    if (!Object.keys(cisto).length)
      return res.status(400).json({ error: 'Unesite bar jednu mjeru.' });
    const premale = Object.entries(cisto).filter(([k, v]) => k !== 'debljina' && v < 20);
    if (premale.length)
      return res.status(400).json({
        error: `Mjere se unose u MILIMETRIMA. Premalo: ${premale.map(([k, v]) => `${MJERE[k].lbl}=${v}`).join(', ')}.`,
      });
    try {
      const n = await pool.query(
        'SELECT COALESCE(MAX(redosled),0)+1 AS r FROM gotov_dimenzije WHERE gotov_id=$1', [req.params.id]
      );
      /* Ostali MOGUCI oblici sa istim mjerama — katalog ih navodi kao opciju.
         Samo oni iste vrste: kruzni sa kruznim, pravougaoni sa pravougaonim. */
      const osnovni = OBLICI[req.body?.oblik] ? req.body.oblik : 'PRAV';
      const jeKruzni = KRUZNI.includes(osnovni);
      const dozvoljeni = jeKruzni ? KRUZNI
                       : STOLOVI.includes(osnovni) ? STOLOVI
                       : PRAVOUGAONI;
      const moguci = Array.isArray(req.body?.moguci_oblici)
        ? req.body.moguci_oblici.filter(o => OBLICI[o] && o !== osnovni && dozvoljeni.includes(o))
        : [];

      const r = await pool.query(
        `INSERT INTO gotov_dimenzije (gotov_id, oblik, mjere, moguci_oblici, naziv, redosled)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, osnovni, JSON.stringify(cisto),
         moguci.length ? moguci : null, req.body?.naziv || null, n.rows[0].r]
      );
      return res.status(201).json(r.rows[0]);
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  if (req.body?.oblik && OBLICI[req.body.oblik]) {
    const ob = req.body.oblik;
    const m = req.body.mjere || {};
    const trazene = OBLICI[ob].dims;
    const fale = trazene.filter(k => !(broj(m[k]) > 0));
    if (fale.length)
      return res.status(400).json({ error: `Nedostaju mjere: ${fale.join(', ')}.` });
    const premale = trazene.filter(k => broj(m[k]) < 20);
    if (premale.length)
      return res.status(400).json({
        error: `Mjere se unose u MILIMETRIMA. Premalo: ${premale.map(k=>`${k}=${broj(m[k])}`).join(', ')}.`,
      });
    try {
      const n = await pool.query(
        'SELECT COALESCE(MAX(redosled),0)+1 AS r FROM gotov_dimenzije WHERE gotov_id=$1', [req.params.id]
      );
      const cisto = {};
      for (const k of trazene) cisto[k] = broj(m[k]);
      const r = await pool.query(
        `INSERT INTO gotov_dimenzije (gotov_id, oblik, mjere, naziv, redosled)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.id, ob, JSON.stringify(cisto), req.body?.naziv || null, n.rows[0].r]
      );
      return res.status(201).json(r.rows[0]);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const oblik = req.body?.oblik === 'krug' ? 'krug' : 'pravougaonik';
  const sirina = broj(req.body?.sirina), visina = broj(req.body?.visina);
  const precnik = broj(req.body?.precnik);

  if (oblik === 'krug') {
    if (precnik <= 0) return res.status(400).json({ error: 'Unesite prečnik (mm).' });
    if (precnik < 100) return res.status(400).json({
      error: `Prečnik se unosi u MILIMETRIMA (npr. 1200). Uneseno: ${precnik}.`,
    });
  } else {
    if (sirina <= 0 || visina <= 0)
      return res.status(400).json({ error: 'Unesite širinu i visinu (mm).' });
    if (sirina < 100 || visina < 100)
      return res.status(400).json({
        error: `Mjere se unose u MILIMETRIMA (npr. 1600 × 900). Uneseno: ${sirina} × ${visina}.`,
      });
  }

  try {
    const n = await pool.query(
      'SELECT COALESCE(MAX(redosled),0)+1 AS r FROM gotov_dimenzije WHERE gotov_id=$1', [req.params.id]
    );
    const r = await pool.query(
      `INSERT INTO gotov_dimenzije (gotov_id, oblik, sirina, visina, precnik, naziv, redosled)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, oblik,
       oblik === 'krug' ? null : sirina,
       oblik === 'krug' ? null : visina,
       oblik === 'krug' ? precnik : null,
       req.body?.naziv || null, n.rows[0].r]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* PATCH /dimenzija/:did — izmjena postojece dimenzije, prije svega mogucih oblika.
   Bez ovoga su se moguci oblici mogli postaviti samo pri dodavanju, pa se poslije
   nisu vidjeli ni mijenjali. */
router.patch('/dimenzija/:did', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const sets = [], vals = [];
  let i = 1;

  if ('moguci_oblici' in req.body) {
    const d = await pool.query('SELECT oblik FROM gotov_dimenzije WHERE id=$1', [req.params.did]);
    if (!d.rows.length) return res.status(404).json({ error: 'Dimenzija nije pronađena.' });
    const osnovni = d.rows[0].oblik || 'PRAV';
    const jeKruzni = KRUZNI.includes(osnovni);
    const dozvoljeni = jeKruzni ? KRUZNI : STOLOVI.includes(osnovni) ? STOLOVI : PRAVOUGAONI;
    const m = Array.isArray(req.body.moguci_oblici)
      ? req.body.moguci_oblici.filter(o => OBLICI[o] && o !== osnovni && dozvoljeni.includes(o))
      : [];
    sets.push(`moguci_oblici=$${i++}`); vals.push(m.length ? m : null);
  }
  if ('naziv' in req.body) { sets.push(`naziv=$${i++}`); vals.push(req.body.naziv || null); }

  if (!sets.length) return res.status(400).json({ error: 'Nema polja za izmjenu.' });
  vals.push(req.params.did);
  try {
    const r = await pool.query(
      `UPDATE gotov_dimenzije SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Dimenzija nije pronađena.' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
/* GET /:id/slike-izbor — sve slike artikala koji ulaze u ovaj proizvod.
   Sluzi da se iz njih izabere ona koja predstavlja GOTOV proizvod. Ako nijedna ne
   odgovara, moze se upisati adresa nove slike. */
/* POST /:id/snimi-cijene — ZAMRZAVA trenutno izracunate cijene.
   Cijene se inace racunaju uzivo iz lagera, pa se mijenjaju cim se promijeni cijena
   neke komponente. Katalog to ne smije — odstampana cijena mora ostati ista.
   Ovdje se snima presjek: koja kombinacija, koja mjera, koja cijena, za kog kupca. */
/* ═══ IMENOVANI CJENOVNICI ═════════════════════════════════════════════════════════
   Jedan proizvod moze imati vise cjenovnika — po tipu kupca, po objektu, po sezoni.
   Snimanjem se cijene upisuju U ODREDJENI cjenovnik, pa se ostali ne diraju. */

router.get('/cjenovnici', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(DISTINCT gotov_id) FROM gotov_cjenovnik g WHERE g.cjenovnik_id = c.id)::int AS broj_proizvoda,
              (SELECT COUNT(*) FROM gotov_cjenovnik g WHERE g.cjenovnik_id = c.id)::int AS broj_cijena
       FROM cjenovnici c
       ${req.query.svi === '1' ? '' : 'WHERE c.aktivan = true'}
       ORDER BY c.naziv`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/cjenovnici', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const naziv = String(req.body?.naziv || '').trim();
  if (!naziv) return res.status(400).json({ error: 'Unesite naziv cjenovnika.' });
  try {
    const u = req.session.user;
    let tipNaziv = null, objNaziv = null;
    if (req.body?.tip_kupca_id) {
      const t = await pool.query('SELECT naziv FROM tipovi_kupaca WHERE id=$1', [req.body.tip_kupca_id]);
      tipNaziv = t.rows[0]?.naziv || null;
    }
    if (req.body?.objekt_id) {
      const o = await pool.query('SELECT naziv, valuta FROM prodajni_objekti WHERE id=$1', [req.body.objekt_id]);
      objNaziv = o.rows[0]?.naziv || null;
    }
    const r = await pool.query(
      `INSERT INTO cjenovnici (naziv, tip_kupca_id, tip_kupca, objekt_id, objekt_naziv,
                               valuta, vazi_od, vazi_do, napomena, kreirao_id, kreirao_ime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [naziv, parseInt(req.body?.tip_kupca_id) || null, tipNaziv,
       parseInt(req.body?.objekt_id) || null, objNaziv,
       req.body?.valuta || 'KM', req.body?.vazi_od || null, req.body?.vazi_do || null,
       req.body?.napomena || null, u.id, u.ime_prezime]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Cjenovnik sa tim nazivom već postoji.' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/cjenovnici/:id', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const DOZ = ['naziv', 'aktivan', 'vazi_od', 'vazi_do', 'napomena'];
  const sets = [], vals = [];
  let i = 1;
  for (const k of DOZ) {
    if (!(k in req.body)) continue;
    sets.push(`${k}=$${i++}`); vals.push(req.body[k] || null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nema polja za izmjenu.' });
  vals.push(req.params.id);
  try {
    const r = await pool.query(`UPDATE cjenovnici SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Cjenovnik nije pronađen.' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/cjenovnici/:id', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  try {
    // Cijene se brisu zajedno sa cjenovnikom — inace bi ostale bez pripadnosti
    await pool.query('DELETE FROM gotov_cjenovnik WHERE cjenovnik_id=$1', [req.params.id]);
    const r = await pool.query('DELETE FROM cjenovnici WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cjenovnik nije pronađen.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/snimi-cijene', async (req, res) => {
  if (!smijeMijenjati(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const redovi = Array.isArray(req.body?.cijene) ? req.body.cijene : null;
  if (!redovi || !redovi.length)
    return res.status(400).json({ error: 'Nema izračunatih cijena za snimanje.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = req.session.user;

    /* Brise se samo presjek TOG proizvoda u TOM cjenovniku — ostali cjenovnici
       ostaju netaknuti. Bez cjenovnik_id ponasa se kao ranije (jedan zajednicki). */
    const cjenovnikId = parseInt(req.body?.cjenovnik_id) || null;
    if (cjenovnikId) {
      await client.query('DELETE FROM gotov_cjenovnik WHERE gotov_id=$1 AND cjenovnik_id=$2',
        [req.params.id, cjenovnikId]);
    } else {
      await client.query('DELETE FROM gotov_cjenovnik WHERE gotov_id=$1 AND cjenovnik_id IS NULL',
        [req.params.id]);
    }

    for (const r of redovi) {
      await client.query(
        `INSERT INTO gotov_cjenovnik
           (gotov_id, cjenovnik_id, kombinacija, opis_izbora, dimenzija, povrsina_m2, cijena, valuta,
            objekt_id, objekt_naziv, tip_kupca_id, tip_kupca, popust_posto, snimio_id, snimio_ime)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [req.params.id, cjenovnikId, r.kombinacija || null, r.opis_izbora || null, r.dimenzija || null,
         broj(r.povrsina_m2), broj(r.cijena), req.body?.valuta || 'KM',
         parseInt(req.body?.objekt_id) || null, req.body?.objekt_naziv || null,
         parseInt(req.body?.tip_kupca_id) || null, req.body?.tip_kupca || null,
         broj(r.popust_posto), u.id, u.ime_prezime]
      );
    }
    await client.query('UPDATE gotovi_proizvodi SET cjenovnik_kada=now() WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, snimljeno: redovi.length });
  } catch (err) {
    await client.query('ROLLBACK');
    /* Ako tabela ne postoji, poruka sa servera je nerazumljiva — ovdje se kaze sta uraditi. */
    if (err.code === '42P01')
      return res.status(500).json({
        error: 'Tabela cjenovnika ne postoji — pokreni migrate_cjenovnik.sql.',
      });
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /:id/cjenovnik — snimljene (zamrznute) cijene
router.get('/:id/cjenovnik', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*, cj.naziv AS cjenovnik_naziv
       FROM gotov_cjenovnik c
       LEFT JOIN cjenovnici cj ON cj.id = c.cjenovnik_id
       WHERE c.gotov_id=$1 ${req.query.cjenovnik_id ? 'AND c.cjenovnik_id=$2' : ''}
       ORDER BY cj.naziv NULLS FIRST, c.dimenzija, c.opis_izbora`,
      req.query.cjenovnik_id ? [req.params.id, req.query.cjenovnik_id] : [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/slike-izbor', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sl.id, sl.url, sl.thumb_url, sl.glavna, sl.gotov_proizvod,
              ro.id AS roba_id, ro.sifra, ro.naziv AS roba_naziv, ro.grupa
       FROM gotov_stavke st
       JOIN roba ro ON ro.id = st.roba_id
       JOIN roba_slike sl ON sl.roba_id = ro.id
       WHERE st.gotov_id = $1
       ORDER BY sl.gotov_proizvod DESC, sl.glavna DESC, ro.naziv, sl.redosled`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
      /* Uz komponentu se povlaci i SLIKA — za vizuelni pregled dok se bira.
         Prednost ima slika gotovog proizvoda; ako je nema, uzima se glavna slika
         artikla (tekstura ploce, fotografija postolja). */
      `SELECT st.*, ro.sifra, ro.naziv AS roba_naziv, ro.jed_mjera, ro.moguci_oblici,
              rp.cijena AS cijena_lager, po.valuta,
              COALESCE(
                (SELECT COALESCE(thumb_url, url) FROM roba_slike
                 WHERE roba_id = ro.id AND gotov_proizvod = true LIMIT 1),
                (SELECT COALESCE(thumb_url, url) FROM roba_slike
                 WHERE roba_id = ro.id AND glavna = true LIMIT 1)
              ) AS slika,
              (SELECT COALESCE(thumb_url, url) FROM roba_slike
               WHERE roba_id = ro.id AND gotov_proizvod = true LIMIT 1) AS slika_gotov
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

    /* Povrsina i obim zavise od OBLIKA. Okrugli sto se ne moze racunati kao pravougaoni
       — Ø1200 daje 1,131 m², a ne 1,44 kao kvadrat iste stranice. */
    /* Mjere dimenzije — novi zapis (oblik + mjere{A,B,...}) ili stari (sirina/visina/precnik).
       Stari se i dalje podrzava da postojece dimenzije ne prestanu da rade. */
    /* Dimenzija proizvoda nosi IMENOVANE mjere: {duzina, sirina, visina, debljina}.
       Povrsina se racuna iz duzine i sirine; visina je opisna (ne ulazi u m²).
       Stari zapisi sa {A,B} i sa sirina/visina se i dalje citaju. */
    function mjere(d) {
      if (!d) return { m2: 0, m1: 0 };
      const m = d.mjere || {};
      if (m.precnik) return mjereOblika('KRUG', { D: m.precnik });
      if (m.duzina || m.sirina)
        return mjereOblika(d.oblik && OBLICI[d.oblik] && d.oblik !== 'I' ? d.oblik : 'PRAV',
                           { A: m.duzina || 0, B: m.sirina || 0, D: m.precnik || 0, R: m.radijus || 0 });
      if (m.A || m.B || m.D) return mjereOblika(d.oblik || 'I', m);
      if (d.precnik) return mjereOblika('KRUG', { D: d.precnik });
      return mjereOblika('I', { A: d.sirina, B: d.visina });
    }

    function racunaj(dim, izabrane) {
      const osnovne = mjere(dim);
      const m2 = osnovne.m2, m1 = osnovne.m1;
      const razrada = [];
      let osnovica = 0, nepotpuno = false;

      for (const st of [...obavezne, ...izabrane]) {
        // Prazan sastojak (jos bez artikla) se preskace — nema sta da se racuna
        if (!st.roba_id && st.fiksna_cijena == null) continue;
        const cijena = st.fiksna_cijena != null
          ? parseFloat(st.fiksna_cijena)
          : (st.cijena_lager != null ? parseFloat(st.cijena_lager) : null);
        if (cijena == null && st.fiksna_cijena == null) nepotpuno = true;

        const mnozilac = parseFloat(st.kolicina) || 1;
        /* MJERA PO KOMPONENTI: kod stepenica svaki dio ima svoju (gaziste 1200×330,
           celo 1200×160). Prazno polje znaci "uzmi iz proizvoda" — tako sto, gdje sve
           dijeli istu mjeru, radi bez ijednog dodatnog unosa. */
        const vlastita = (st.sirina_kom != null || st.visina_kom != null);
        const mv = vlastita
          ? mjereOblika('I', { A: st.sirina_kom ?? dim?.sirina, B: st.visina_kom ?? dim?.visina })
          : { m2, m1 };
        const kol = st.tip_kolicine === 'povrsina' ? mv.m2 * mnozilac
                  : st.tip_kolicine === 'duzina'   ? mv.m1 * mnozilac
                  : mnozilac;
        /* TRI nacina da se dodje do jedinicne cijene, po prioritetu:
             1. FIKSNA cijena  — upisana rucno, ide direktno (bez faktora i marze)
             2. faktor         — cijena iz lagera × faktor
             3. marza %        — cijena iz lagera + marza
           Faktor i marza se mogu i kombinovati (× faktor, pa + marza). */
        const faktor = parseFloat(st.faktor) || 1;
        const marza = parseFloat(st.marza_posto) || 0;
        const jeFiksna = st.fiksna_cijena != null;
        const jedinicna = jeFiksna
          ? parseFloat(st.fiksna_cijena)
          : (cijena || 0) * faktor * (1 + marza / 100);
        const iznos = jedinicna * kol;
        osnovica += iznos;
        razrada.push({
          stavka_id: st.id,
          grupa_izbora: st.grupa_izbora || null,
          naziv: st.roba_naziv || st.opis, sifra: st.sifra,
          slika: st.slika || null,
          kolicina: +kol.toFixed(3),
          jedinica: st.tip_kolicine === 'povrsina' ? 'm²' : st.tip_kolicine === 'duzina' ? 'm¹' : (st.jed_mjera || 'kom'),
          cijena: cijena != null ? +cijena.toFixed(2) : null,
          jedinicna: +jedinicna.toFixed(2),
          faktor, marza_posto: marza, fiksna: jeFiksna,
          iznos: +iznos.toFixed(2),
          // Fiksna cijena ne treba lager — samo ostale prijavljuju da fali
          bez_cijene: !jeFiksna && cijena == null,
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
        dimenzija: dim ? (dim.naziv || (dim.mjere && dim.oblik
          ? opisOblika(dim.oblik, dim.mjere)
          : (dim.oblik === 'krug' || dim.precnik
             ? `Ø${Math.round(dim.precnik)}`
             : `${Math.round(dim.sirina)}×${Math.round(dim.visina)}`))) : null,
        izbor: izabrane.map(x => ({
          grupa: x.grupa_izbora, stavka_id: x.id,
          naziv: x.roba_naziv || x.opis, sifra: x.sifra,
          slika: x.slika || null,
        })),
        /* Za veliki pregled: slika gotovog proizvoda one komponente koja je ima.
           Obicno je to ploca — njena slika pokazuje kako sto izgleda gotov. */
        /* Slika PROIZVODA ima prednost — ona pokazuje gotov sto, a ne teksturu ploce. */
        slika_pregled: proizvod.slika_url
                    || [...izabrane, ...obavezne].find(x => x.slika_gotov)?.slika_gotov
                    || [...izabrane].find(x => x.slika)?.slika || null,
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
    let preskoceno = 0;
    for (const dim of dimenzije) {
      for (const komb of kombinacijeZaRacun) {
        /* NEMOGUCE KOMBINACIJE se ne racunaju. Neka postolja ne nose okrugle ni
           bacvaste ploce — takav sto se ne moze napraviti, pa mu ni cijena ne treba.
           Ogranicenje stoji na ARTIKLU (roba.moguci_oblici), ne u sastavnici, da se
           ne ponavlja za svaki nov sto. */
        if (dim?.oblik) {
          const zabranjeno = [...obavezne, ...komb].some(st =>
            Array.isArray(st.moguci_oblici) && st.moguci_oblici.length &&
            !st.moguci_oblici.includes(dim.oblik));
          if (zabranjeno) { preskoceno++; continue; }
        }
        redovi.push(racunaj(dim, komb));
      }
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
          slika: x.slika || null,
        })),
      })),
      broj_kombinacija: sveKombinacije.length * dimenzije.length,
      // Koliko je izostavljeno jer postolje ne nosi taj oblik
      preskoceno_zbog_oblika: preskoceno,
      // Kad kombinacija ima previse, vraca se prvih 200 — vise od toga niko ne cita
      skraceno: sveKombinacije.length > MAX_KOMBINACIJA,
      cijene: redovi,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
