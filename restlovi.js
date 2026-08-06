// restlovi.js — modul RESTLOVI / BESTANDING
// Dimenzije u MILIMETRIMA, površina u m2, cijena u KM/m2.
//
// Osnovna ideja: restl nastaje ili rezanjem cijele table (izvor='tabla', veza na roba/lager)
// ili rezanjem drugog restla (izvor='restl', roditelj_id). Kad se restl uzme za nalog,
// od njega može nastati NOVI restl (dijete) — i tako u krug, dok se ne označi potrošenim.
// Cijenu po m2 dijete uvijek nasljeđuje od roditelja.

const express = require('express');
const router = express.Router();
const pool = require('./db');

/* ─────────────────────────── pomoćne funkcije ─────────────────────────── */

// Površina u m2. L-oblik = puni pravougaonik minus izrez.
function povrsinaM2(oblik, a, b, c, d) {
  const A = Number(a) || 0, B = Number(b) || 0;
  const C = Number(c) || 0, D = Number(d) || 0;
  const mm2 = oblik === 'L' ? (A * B - C * D) : (A * B);
  return Math.max(0, mm2) / 1000000;
}

// Da li komad w×h staje u restl? Restl se razlaže na pravougaonike:
//  - pravougaonik: jedan (A×B)
//  - L (izrez C×D u gornjem desnom uglu): (A−C)×B  i  A×(B−D)
// Komad staje ako staje u BILO KOJI od njih, u bilo kojoj od dvije rotacije.
function pravougaoniciRestla(r) {
  const A = Number(r.dim_a), B = Number(r.dim_b);
  if (r.oblik !== 'L') return [[A, B]];
  const C = Number(r.dim_c) || 0, D = Number(r.dim_d) || 0;
  return [[A - C, B], [A, B - D]];
}

function staje(r, w, h, rez) {
  const t = Number(rez) || 0; // debljina reza / sigurnosna rezerva u mm
  const W = Number(w) + t, H = Number(h) + t;
  return pravougaoniciRestla(r).some(([pw, ph]) =>
    (W <= pw && H <= ph) || (H <= pw && W <= ph)
  );
}

// Koliko m2 "propada" ako se komad izreže iz ovog restla — manje je bolje (best-fit).
function otpadM2(r, w, h) {
  return Math.max(0, Number(r.povrsina) - (Number(w) * Number(h)) / 1000000);
}

async function sljedecaOznaka(client) {
  const god = new Date().getFullYear();
  const r = await client.query(
    `SELECT oznaka FROM restlovi WHERE oznaka LIKE $1 ORDER BY oznaka DESC LIMIT 1`,
    [`R-${god}-%`]
  );
  const zadnji = r.rows.length ? parseInt(r.rows[0].oznaka.split('-')[2], 10) : 0;
  return `R-${god}-${String(zadnji + 1).padStart(4, '0')}`;
}

async function upisiLog(client, restlId, kolona, staro, novo, user) {
  await client.query(
    `INSERT INTO restl_log (restl_id, kolona, staro, novo, korisnik_id, ko)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [restlId, kolona, staro === null || staro === undefined ? null : String(staro),
     novo === null || novo === undefined ? null : String(novo),
     user?.id || null, user?.ime_prezime || null]
  );
}

/* ─────────────────────────── dozvole ─────────────────────────── */

async function dozvole(user) {
  if (!user) return { vidi: false, unos: false };
  if (user.rola === 'admin') return { vidi: true, unos: true, admin: true };
  // Uživo iz baze (kao ima_prodaju_pj u auth.js) — da nova dozvola važi odmah,
  // bez ponovne prijave korisnika.
  const r = await pool.query(
    'SELECT moze_restlovi, moze_restlovi_unos FROM zaposleni WHERE id=$1', [user.id]
  );
  if (!r.rows.length) return { vidi: false, unos: false };
  return { vidi: !!r.rows[0].moze_restlovi, unos: !!r.rows[0].moze_restlovi_unos };
}

async function smijeVidjeti(req, res, next) {
  const d = await dozvole(req.session?.user);
  if (!d.vidi) return res.status(403).json({ error: 'Nemate dozvolu za pregled restlova.' });
  req.restlDozvole = d;
  next();
}

async function smijeUnositi(req, res, next) {
  const d = await dozvole(req.session?.user);
  if (!d.unos) return res.status(403).json({ error: 'Nemate dozvolu za unos/izmjenu restlova.' });
  req.restlDozvole = d;
  next();
}

// GET /api/restlovi/dozvole/moje — frontend ovim odlučuje šta da prikaže
router.get('/dozvole/moje', async (req, res) => {
  try {
    res.json(await dozvole(req.session?.user));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─────────────────────────── lista i pretraga ─────────────────────────── */

// GET /api/restlovi?objekt_id=&status=&materijal=&q=
router.get('/', smijeVidjeti, async (req, res) => {
  try {
    const uslovi = [];
    const vals = [];
    let i = 1;
    if (req.query.objekt_id) { uslovi.push(`r.objekt_id = $${i++}`); vals.push(req.query.objekt_id); }
    if (req.query.status)    { uslovi.push(`r.status = $${i++}`);    vals.push(req.query.status); }
    else                     { uslovi.push(`r.status <> 'potrosen'`); }
    if (req.query.materijal) { uslovi.push(`r.materijal ILIKE $${i++}`); vals.push(`%${req.query.materijal}%`); }
    if (req.query.q)         { uslovi.push(`(r.oznaka ILIKE $${i} OR r.materijal ILIKE $${i} OR r.napomena ILIKE $${i})`); vals.push(`%${req.query.q}%`); i++; }

    const r = await pool.query(
      `SELECT r.*, po.naziv AS objekt_naziv, po.valuta,
              (r.povrsina * r.cijena_m2) AS vrijednost,
              rod.oznaka AS roditelj_oznaka
         FROM restlovi r
         LEFT JOIN prodajni_objekti po ON po.id = r.objekt_id
         LEFT JOIN restlovi rod ON rod.id = r.roditelj_id
        ${uslovi.length ? 'WHERE ' + uslovi.join(' AND ') : ''}
        ORDER BY r.kreirano DESC
        LIMIT 500`,
      vals
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/restlovi/trazi — GLAVNA RUTA: "da li imam restl za ovaj komad?"
// body: { sirina, visina, materijal, objekt_id?, rez?, debljina_cm?, grupa? }
// Vraća kandidate (best-fit prvo). Ako ih nema — prijedlog: cijela tabla sa lagera.
router.post('/trazi', smijeVidjeti, async (req, res) => {
  try {
    const { sirina, visina, materijal, objekt_id, rez, debljina_cm, grupa } = req.body;
    if (!sirina || !visina) return res.status(400).json({ error: 'Širina i visina su obavezne.' });

    const uslovi = [`r.status = 'dostupan'`];
    const vals = [];
    let i = 1;
    if (materijal) { uslovi.push(`r.materijal ILIKE $${i++}`); vals.push(`%${materijal}%`); }
    if (objekt_id) { uslovi.push(`r.objekt_id = $${i++}`); vals.push(objekt_id); }
    if (debljina_cm) { uslovi.push(`r.debljina_cm = $${i++}`); vals.push(debljina_cm); }
    if (grupa)       { uslovi.push(`r.grupa = $${i++}`); vals.push(grupa); }

    // Predfilter u bazi (grubo, po najvećoj mjeri) da ne vučemo cijelu tabelu,
    // pa precizna provjera oblika u JS-u.
    const min = Math.min(Number(sirina), Number(visina));
    const max = Math.max(Number(sirina), Number(visina));
    uslovi.push(`GREATEST(r.dim_a, r.dim_b) >= $${i++}`); vals.push(max);
    uslovi.push(`LEAST(r.dim_a, r.dim_b) >= $${i++}`);    vals.push(min);

    const q = await pool.query(
      `SELECT r.*, po.naziv AS objekt_naziv
         FROM restlovi r
         LEFT JOIN prodajni_objekti po ON po.id = r.objekt_id
        WHERE ${uslovi.join(' AND ')}
        LIMIT 300`,
      vals
    );

    const kandidati = q.rows
      .filter(r => staje(r, sirina, visina, rez))
      .map(r => ({ ...r, otpad_m2: otpadM2(r, sirina, visina) }))
      .sort((a, b) => a.otpad_m2 - b.otpad_m2)
      .slice(0, 20);

    if (kandidati.length) return res.json({ ima: true, kandidati });

    // Nema restla — nudimo cijelu tablu sa lager liste
    const tableUslovi = [`rp.stanje > 0`];
    const tv = [];
    let j = 1;
    if (materijal)   { tableUslovi.push(`ro.naziv ILIKE $${j++}`); tv.push(`%${materijal}%`); }
    if (objekt_id)   { tableUslovi.push(`rp.objekt_id = $${j++}`); tv.push(objekt_id); }
    if (grupa)       { tableUslovi.push(`ro.grupa = $${j++}`); tv.push(grupa); }
    if (debljina_cm) { tableUslovi.push(`ro.debljina_cm = $${j++}`); tv.push(debljina_cm); }
    const table = await pool.query(
      `SELECT ro.id AS roba_id, ro.sifra, ro.naziv, ro.jed_mjera, ro.grupa, ro.debljina_cm,
              rp.cijena, rp.stanje, rp.objekt_id, po.naziv AS objekt_naziv
         FROM roba ro
         JOIN roba_pj rp ON rp.roba_id = ro.id
         LEFT JOIN prodajni_objekti po ON po.id = rp.objekt_id
        WHERE ${tableUslovi.join(' AND ')}
        ORDER BY ro.naziv LIMIT 30`,
      tv
    );
    res.json({ ima: false, kandidati: [], table: table.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─────────────────────────── unos ─────────────────────────── */

// POST /api/restlovi — novi restl (iz cijele table ili ručno)
router.post('/', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    const {
      objekt_id, roba_id, materijal, grupa, debljina_cm, oblik,
      dim_a, dim_b, dim_c, dim_d, cijena_m2, foto_url,
      roditelj_id, nastao_iz_naloga, izvor, lokacija, napomena
    } = req.body;

    if (!objekt_id) return res.status(400).json({ error: 'PJ (objekt_id) je obavezan.' });
    if (!materijal) return res.status(400).json({ error: 'Materijal je obavezan.' });
    if (!dim_a || !dim_b) return res.status(400).json({ error: 'Mjere A i B su obavezne.' });
    const ob = oblik === 'L' ? 'L' : 'pravougaonik';
    if (ob === 'L' && (!dim_c || !dim_d)) return res.status(400).json({ error: 'Za L-oblik su obavezne i mjere C i D.' });

    await client.query('BEGIN');

    // Cijena po m2: ako nije data, nasljeđuje se od roditelja, pa onda sa lagera
    let cijena = Number(cijena_m2) || 0;
    if (!cijena && roditelj_id) {
      const p = await client.query('SELECT cijena_m2 FROM restlovi WHERE id=$1', [roditelj_id]);
      cijena = p.rows.length ? Number(p.rows[0].cijena_m2) : 0;
    }
    if (!cijena && roba_id) {
      // Cijena sa lagera se preuzima SAMO ako je artikal vođen u m2 — kod 'kom'
      // artikala rp.cijena je cijena po komadu i ne smije se tretirati kao KM/m2.
      const p = await client.query(
        `SELECT rp.cijena FROM roba_pj rp JOIN roba ro ON ro.id = rp.roba_id
          WHERE rp.roba_id=$1 AND rp.objekt_id=$2 AND LOWER(ro.jed_mjera)='m2'`,
        [roba_id, objekt_id]
      );
      cijena = p.rows.length ? Number(p.rows[0].cijena) : 0;
    }

    const oznaka = await sljedecaOznaka(client);
    const pov = povrsinaM2(ob, dim_a, dim_b, dim_c, dim_d);

    const r = await client.query(
      `INSERT INTO restlovi
         (oznaka, objekt_id, roba_id, materijal, grupa, debljina_cm, oblik,
          dim_a, dim_b, dim_c, dim_d, povrsina, cijena_m2, foto_url,
          roditelj_id, nastao_iz_naloga, izvor, lokacija, napomena,
          kreirao_id, kreirao_ime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [oznaka, objekt_id, roba_id || null, materijal, grupa || null, debljina_cm || null, ob,
       dim_a, dim_b, dim_c || 0, dim_d || 0, pov, cijena, foto_url || null,
       roditelj_id || null, nastao_iz_naloga || null,
       izvor || (roditelj_id ? 'restl' : 'tabla'), lokacija || null, napomena || null,
       user.id, user.ime_prezime]
    );

    await upisiLog(client, r.rows[0].id, 'kreiran', null, oznaka, user);
    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/restlovi/:id/koristi — restl ide na nalog; od ostatka nastaje NOVI restl
// body: { nalog_r_br, uzeto_a, uzeto_b, potrosen_do_kraja,
//         ostatak: { oblik, dim_a, dim_b, dim_c, dim_d, foto_url, lokacija, napomena } | null }
router.post('/:id/koristi', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    const { nalog_r_br, uzeto_a, uzeto_b, potrosen_do_kraja, ostatak, napomena } = req.body;

    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM restlovi WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restl nije pronađen.' }); }
    const r = cur.rows[0];
    if (r.status === 'potrosen') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Restl je već označen kao potrošen.' }); }

    let noviId = null;
    if (ostatak && ostatak.dim_a && ostatak.dim_b && !potrosen_do_kraja) {
      const ob = ostatak.oblik === 'L' ? 'L' : 'pravougaonik';
      const pov = povrsinaM2(ob, ostatak.dim_a, ostatak.dim_b, ostatak.dim_c, ostatak.dim_d);
      const oznaka = await sljedecaOznaka(client);
      const ins = await client.query(
        `INSERT INTO restlovi
           (oznaka, objekt_id, roba_id, materijal, grupa, debljina_cm, oblik,
            dim_a, dim_b, dim_c, dim_d, povrsina, cijena_m2, foto_url,
            roditelj_id, nastao_iz_naloga, izvor, lokacija, napomena, kreirao_id, kreirao_ime)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'restl',$17,$18,$19,$20)
         RETURNING id, oznaka`,
        [oznaka, r.objekt_id, r.roba_id, r.materijal, r.grupa, r.debljina_cm, ob,
         ostatak.dim_a, ostatak.dim_b, ostatak.dim_c || 0, ostatak.dim_d || 0,
         pov, r.cijena_m2, ostatak.foto_url || null, r.id, nalog_r_br || null,
         ostatak.lokacija || r.lokacija, ostatak.napomena || null, user.id, user.ime_prezime]
      );
      noviId = ins.rows[0].id;
      await upisiLog(client, noviId, 'kreiran', null, `${ins.rows[0].oznaka} (od ${r.oznaka})`, user);
    }

    // Roditelj se uvijek zatvara — ili je potrošen do kraja, ili je "prešao" u dijete
    await client.query(
      `UPDATE restlovi SET status='potrosen', potrosio_id=$1, potrosio_ime=$2, potroseno=now()
       WHERE id=$3`,
      [user.id, user.ime_prezime, r.id]
    );
    await upisiLog(client, r.id, 'status', r.status, 'potrosen', user);

    const uzetoPov = (Number(uzeto_a) || 0) * (Number(uzeto_b) || 0) / 1000000;
    await client.query(
      `INSERT INTO restl_koristenje
         (restl_id, nalog_r_br, uzeto_a, uzeto_b, uzeto_povrsina, novi_restl_id,
          potrosen_do_kraja, korisnik_id, korisnik_ime, napomena)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.id, nalog_r_br || null, uzeto_a || null, uzeto_b || null, uzetoPov,
       noviId, !!potrosen_do_kraja || !noviId, user.id, user.ime_prezime, napomena || null]
    );

    await client.query('COMMIT');
    res.json({ ok: true, novi_restl_id: noviId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/restlovi/:id/prenos — prenos u drugi PJ
router.post('/:id/prenos', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    const { u_objekt_id, napomena } = req.body;
    if (!u_objekt_id) return res.status(400).json({ error: 'Odredišni PJ je obavezan.' });

    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM restlovi WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restl nije pronađen.' }); }
    const r = cur.rows[0];
    if (String(r.objekt_id) === String(u_objekt_id)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Restl je već u tom PJ.' }); }

    await client.query('UPDATE restlovi SET objekt_id=$1 WHERE id=$2', [u_objekt_id, r.id]);
    await client.query(
      `INSERT INTO restl_prenosi (restl_id, iz_objekt_id, u_objekt_id, korisnik_id, korisnik_ime, napomena)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.id, r.objekt_id, u_objekt_id, user.id, user.ime_prezime, napomena || null]
    );
    await upisiLog(client, r.id, 'objekt_id', r.objekt_id, u_objekt_id, user);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// PATCH /api/restlovi/:id — inline izmjena, svaka promjena ide u restl_log
const IZMJENJIVE = ['materijal', 'grupa', 'debljina_cm', 'oblik', 'dim_a', 'dim_b', 'dim_c', 'dim_d',
                    'cijena_m2', 'foto_url', 'lokacija', 'napomena', 'status', 'nastao_iz_naloga'];

router.patch('/:id', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    const polja = Object.keys(req.body).filter(k => IZMJENJIVE.includes(k));
    if (!polja.length) return res.status(400).json({ error: 'Nema polja za izmjenu.' });

    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM restlovi WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restl nije pronađen.' }); }
    const stari = cur.rows[0];

    const sets = [];
    const vals = [];
    let i = 1;
    for (const p of polja) {
      sets.push(`${p} = $${i++}`);
      vals.push(req.body[p]);
      await upisiLog(client, stari.id, p, stari[p], req.body[p], user);
    }
    // Ako su dirane mjere ili oblik — površina se preračunava
    const nov = { ...stari, ...req.body };
    const pov = povrsinaM2(nov.oblik, nov.dim_a, nov.dim_b, nov.dim_c, nov.dim_d);
    sets.push(`povrsina = $${i++}`); vals.push(pov);

    vals.push(req.params.id);
    const r = await client.query(
      `UPDATE restlovi SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals
    );
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* ─────────────────────────── istorija ─────────────────────────── */

// GET /api/restlovi/:id/log — desni klik → "Istorija promjena"
router.get('/:id/log', smijeVidjeti, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, kolona, staro, novo, ko, kada FROM restl_log
        WHERE restl_id=$1 ${req.query.polje ? 'AND kolona=$2' : ''}
        ORDER BY kada DESC LIMIT 20`,
      req.query.polje ? [req.params.id, req.query.polje] : [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/restlovi/:id/undo/:logId — vraća SAMO najnoviju promjenu te kolone
router.post('/:id/undo/:logId', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lg = await client.query('SELECT * FROM restl_log WHERE id=$1 AND restl_id=$2',
      [req.params.logId, req.params.id]);
    if (!lg.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Zapis u istoriji nije pronađen.' }); }
    const log = lg.rows[0];
    if (!IZMJENJIVE.includes(log.kolona)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Ova promjena se ne može poništiti.' }); }

    const zadnji = await client.query(
      'SELECT id FROM restl_log WHERE restl_id=$1 AND kolona=$2 ORDER BY kada DESC LIMIT 1',
      [req.params.id, log.kolona]
    );
    if (String(zadnji.rows[0].id) !== String(log.id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Može se poništiti samo NAJNOVIJA promjena ovog polja.' });
    }

    await client.query(`UPDATE restlovi SET ${log.kolona} = $1 WHERE id = $2`, [log.staro, req.params.id]);
    await upisiLog(client, req.params.id, log.kolona, log.novo, log.staro, user);
    await client.query('COMMIT');
    res.json({ ok: true, vraceno_na: log.staro });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/restlovi/:id/rodovnik — cijeli lanac: od koje table/restla je nastao i šta
// je od njega nastalo. Jedan rekurzivan upit, bez petlji.
router.get('/:id/rodovnik', smijeVidjeti, async (req, res) => {
  try {
    const r = await pool.query(
      `WITH RECURSIVE preci AS (
          SELECT * FROM restlovi WHERE id = $1
          UNION ALL
          SELECT r.* FROM restlovi r JOIN preci p ON r.id = p.roditelj_id
       ), potomci AS (
          SELECT * FROM restlovi WHERE id = $1
          UNION ALL
          SELECT r.* FROM restlovi r JOIN potomci p ON r.roditelj_id = p.id
       )
       SELECT DISTINCT ON (id) id, oznaka, oblik, dim_a, dim_b, dim_c, dim_d,
              povrsina, cijena_m2, status, roditelj_id, nastao_iz_naloga, izvor,
              foto_url, kreirao_ime, kreirano
         FROM (SELECT * FROM preci UNION ALL SELECT * FROM potomci) x
        ORDER BY id`,
      [req.params.id]
    );
    const kor = await pool.query(
      `SELECT k.*, r.oznaka FROM restl_koristenje k
         JOIN restlovi r ON r.id = k.restl_id
        WHERE k.restl_id = ANY($1::int[]) ORDER BY k.kada`,
      [r.rows.map(x => x.id)]
    );
    res.json({ komadi: r.rows, koristenja: kor.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/restlovi/nalog/:r_br — koji su restlovi otišli na ovaj nalog
router.get('/nalog/:r_br', smijeVidjeti, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT k.*, r.oznaka, r.materijal, r.cijena_m2,
              (k.uzeto_povrsina * r.cijena_m2) AS vrijednost
         FROM restl_koristenje k
         JOIN restlovi r ON r.id = k.restl_id
        WHERE k.nalog_r_br = $1 ORDER BY k.kada`,
      [req.params.r_br]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/restlovi/sume — kartice na vrhu stranice
router.get('/sume/pregled', smijeVidjeti, async (req, res) => {
  try {
    const [ukupno, poPj, poMat] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS komada, COALESCE(SUM(povrsina),0) AS m2,
                         COALESCE(SUM(povrsina*cijena_m2),0) AS vrijednost
                    FROM restlovi WHERE status='dostupan'`),
      pool.query(`SELECT po.id, po.naziv, po.valuta, COUNT(*)::int AS komada,
                         COALESCE(SUM(r.povrsina),0) AS m2,
                         COALESCE(SUM(r.povrsina*r.cijena_m2),0) AS vrijednost
                    FROM restlovi r LEFT JOIN prodajni_objekti po ON po.id=r.objekt_id
                   WHERE r.status='dostupan' GROUP BY po.id, po.naziv, po.valuta ORDER BY po.naziv`),
      pool.query(`SELECT materijal, COUNT(*)::int AS komada, COALESCE(SUM(povrsina),0) AS m2
                    FROM restlovi WHERE status='dostupan'
                   GROUP BY materijal ORDER BY m2 DESC LIMIT 15`),
    ]);
    res.json({ ukupno: ukupno.rows[0], po_pj: poPj.rows, po_materijalu: poMat.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
