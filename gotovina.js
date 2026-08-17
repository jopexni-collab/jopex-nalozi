const express = require('express');
const router = express.Router();
const pool = require('./db');

const KURS_EUR_KM = 1.95;

// Pristup: admin (sve) ili blagajnik/prodavac (samo svoje PJ — server ga FORSIRA na te PJ
// bez obzira šta klijent pošalje, da niko ne može da vidi tuđu blagajnu mijenjajući
// parametre). Jedna osoba može biti blagajnik i/ili prodavac za VIŠE PJ (blagajnici_pj i
// prodavci_pj tabele) — ko god ima BAR JEDNO od ta dva ovlašćenja za neki PJ, vidi
// gotovinu/VP/banka SAMO za te PJ. Ranije je ovo bilo ISKLJUČIVO za blagajnike — prodavac
// bez blagajnik uloge je dobijao potpuno odbijen pristup (403), čak i za PJ gde prodaje.
router.use(async (req, res, next) => {
  const u = req.session?.user;
  if (!u) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  if (u.rola === 'admin') return next();
  try {
    const r = await pool.query(
      `SELECT DISTINCT p.id, p.naziv FROM prodajni_objekti p
       WHERE p.id IN (SELECT objekat_id FROM blagajnici_pj WHERE zaposleni_id = $1)
          OR p.id IN (SELECT objekat_id FROM prodavci_pj WHERE zaposleni_id = $1)`,
      [u.id]
    );
    if (!r.rows.length) return res.status(403).json({ error: 'Nemate pristup blagajni.' });
    req.blagajnikObjektIds = r.rows.map(row => row.id);
    req.blagajnikObjektNazivi = r.rows.map(row => row.naziv);
    return next();
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// GET /api/gotovina - lista svih uplata
router.get('/', async (req, res) => {
  try {
    const { od, do: do_, primio, izvor, nepredano, objekt_naziv, komercijalista } = req.query;
    let where = [];
    let vals = [];
    let i = 1;
    if (od) { where.push(`g.datum >= $${i++}`); vals.push(od); }
    if (do_) { where.push(`g.datum <= $${i++}`); vals.push(do_); }
    if (primio) { where.push(`g.primio = $${i++}`); vals.push(primio); }
    if (izvor) { where.push(`g.izvor = $${i++}`); vals.push(izvor); }
    if (nepredano === 'true') { where.push(`g.predao_blagajniku = false`); }
    if (objekt_naziv) { where.push(`g.objekt_naziv = $${i++}`); vals.push(objekt_naziv); }
    if (komercijalista) {
      where.push(`(p.ugovorio = $${i} OR o.komercijalista_ime = $${i})`);
      vals.push(komercijalista); i++;
    }
    // Blagajnik je FORSIRAN da vidi SVOJE PJ (jedan ili više) — ALI i SVE zapise koji NISU
    // vezani ni za jedan PJ (npr. naplata sa radnog naloga, koja nema objekt_naziv jer nije
    // maloprodajna) — takav novac je "zajednička" odgovornost svih blagajnika (ko god ga
    // trenutno drži/obrađuje), ne samo onoga ko ga je lično upisao.
    if (req.blagajnikObjektNazivi) {
      where.push(`(g.objekt_naziv = ANY($${i++}::text[]) OR g.objekt_naziv IS NULL)`);
      vals.push(req.blagajnikObjektNazivi);
    }
    // "Nalog/Otp" kolona (g.nalog_r_br) sad drži i broj radnog naloga i broj otpremnice iz
    // maloprodaje (tekst, npr. "OTP-2026-000123") — zato je tip kolone VARCHAR. Ovdje se
    // poredi kao tekst (p.r_br::text), inače bi Postgres bacio grešku tipa na ne-brojčane
    // vrijednosti (otpremnica brojevi). Za redove sa OTP brojem JOIN jednostavno neće naći
    // poklapanje (narucilac/zadatak ostaju NULL), što je ispravno ponašanje.
    // Drugi LEFT JOIN (na otpremnice) hvata OTP-brojeve — "komercijalista" tako pokriva
    // OBA izvora (proizvodnja preko ugovorio, maloprodaja preko komercijalista_ime).
    const sql = `SELECT g.*, p.narucilac, p.zadatak, p.ugovorio,
        COALESCE(o.komercijalista_ime, p.ugovorio) AS komercijalista_ime,
        COALESCE(po.valuta,'KM') AS valuta
      FROM gotovina g
      LEFT JOIN proizvodnja_jopex p ON g.nalog_r_br = p.r_br::text
      LEFT JOIN otpremnice o ON g.nalog_r_br = o.broj
      LEFT JOIN prodajni_objekti po ON po.naziv = g.objekt_naziv
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY g.datum DESC, g.kreirano DESC`;
    const r = await pool.query(sql, vals);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gotovina/suma - suma po danu/sedmici/mjesecu. Ako neki PJ radi u EUR, njegovi
// iznosi se KONVERTUJU u KM-ekvivalent (fiksni kurs) PRIJE sabiranja — inače bi zbir preko
// više PJ bio netačan (mešanje KM i EUR kao da su ista jedinica).
router.get('/suma', async (req, res) => {
  try {
    const filterGlavni = req.blagajnikObjektNazivi
      ? `WHERE g.objekt_naziv = ANY($1::text[])`
      : '';
    const glavniVals = req.blagajnikObjektNazivi ? [req.blagajnikObjektNazivi] : [];
    const r = await pool.query(`
      SELECT
        SUM(iznos_km) FILTER (WHERE datum = CURRENT_DATE) AS danas,
        SUM(iznos_km) FILTER (WHERE datum >= date_trunc('week', CURRENT_DATE)) AS ova_sedmica,
        SUM(iznos_km) FILTER (WHERE date_trunc('month', datum) = date_trunc('month', CURRENT_DATE)) AS ovaj_mjesec,
        SUM(iznos_km) FILTER (WHERE predao_blagajniku = false) AS nepredano
      FROM (
        SELECT g.datum, g.predao_blagajniku,
          CASE WHEN p.valuta = 'EUR' THEN g.iznos * ${KURS_EUR_KM} ELSE g.iznos END AS iznos_km
        FROM gotovina g
        LEFT JOIN prodajni_objekti p ON p.naziv = g.objekt_naziv
        WHERE NOT (
          g.opis LIKE 'Dug po otpremnici%'
          AND NOT EXISTS (SELECT 1 FROM gotovina g2 WHERE g2.nalog_r_br=g.nalog_r_br AND g2.opis LIKE 'Prodaja (bruto)%')
        )
        ${filterGlavni ? 'AND g.objekt_naziv = ANY($1::text[])' : ''}
      ) sub
    `, glavniVals);

    // "Nije predano" RAZDVOJENO po PJ — svaki PJ ima svoj zbir, u SVOJOJ nativnoj valuti
    // (ne KM-normalizovano kao gornji ukupan zbir, jer je ovo prikaz po jednom PJ).
    // BEZBJEDNOST: blagajnik smije vidjeti SAMO svoje PJ ovdje — req.blagajnikObjektNazivi
    // (postavljen u middleware-u iznad) FORSIRA filter za ne-admina.
    let nepredanoPoPJ = [];
    try {
      const filterPJ = req.blagajnikObjektNazivi
        ? `AND g.objekt_naziv = ANY($1::text[])`
        : '';
      const npjVals = req.blagajnikObjektNazivi ? [req.blagajnikObjektNazivi] : [];
      const npj = await pool.query(`
        SELECT COALESCE(g.objekt_naziv,'(bez PJ)') AS objekt_naziv,
               g.izvor,
               COALESCE(p.valuta,'KM') AS valuta,
               SUM(g.iznos) AS iznos
        FROM gotovina g
        LEFT JOIN prodajni_objekti p ON p.naziv = g.objekt_naziv
        WHERE g.predao_blagajniku = false
          AND NOT (
            g.opis LIKE 'Dug po otpremnici%'
            AND NOT EXISTS (SELECT 1 FROM gotovina g2 WHERE g2.nalog_r_br=g.nalog_r_br AND g2.opis LIKE 'Prodaja (bruto)%')
          )
          ${filterPJ}
        GROUP BY COALESCE(g.objekt_naziv,'(bez PJ)'), g.izvor, COALESCE(p.valuta,'KM')
        HAVING SUM(g.iznos) != 0
        ORDER BY 1
      `, npjVals);
      // "Proizvodnja" prikazuje SVOJU posebnu karticu (odvojeno od PJ maloprodaje), iako
      // dijele isti objekt_naziv (novac se sliva u istu blagajnu — samo prikaz razdvojen).
      nepredanoPoPJ = npj.rows.map(row => ({
        objekt_naziv: row.objekt_naziv,
        prikaz_naziv: row.izvor === 'Proizvodnja' ? 'Proizvodnja' : row.objekt_naziv,
        izvor: row.izvor,
        valuta: row.valuta, iznos: +parseFloat(row.iznos).toFixed(2),
      }));
    } catch (e) { /* ne rušimo cijelu rutu zbog ovoga */ }

    // Naloga — "Naplaćeno" sad uključuje SVE stvarno primljeno: za naloge oznacene
    // "naplaćeno" (checkbox) = cijela ugovorena suma; za naloge JOŠ NE oznacene = ono što
    // je već stvarno stiglo (avans + naplaceno_iznos), ne 0 — inače avans "nestaje" iz
    // prikaza (ni u Naplaćeno ni u Očekivano). "Očekivano od naloga" ostaje nepromijenjeno
    // (ugovorena_suma - avans - naplaceno_iznos za ne-naplaćene) — ISTA formula kao
    // proizvodnja.js/lista.html, ovako se za svaki nalog Naplaćeno+Očekivano tačno slaže
    // sa ugovorena_suma (ništa se ne gubi niti duplira). Isključuje STORNIRANE naloge.
    let naplacenoNalozi = 0, ocekivanoNalozi = 0;
    try {
      const rn = await pool.query(`
        SELECT
          COALESCE(SUM(
            CASE WHEN naplaceno IS TRUE THEN COALESCE(ugovorena_suma,0)
                 ELSE COALESCE(avans,0) + COALESCE(naplaceno_iznos,0) END
          ) FILTER (WHERE COALESCE(stornirano,false)=false), 0) AS naplaceno_ukupno,
          COALESCE(SUM(COALESCE(ugovorena_suma,0) - COALESCE(avans,0) - COALESCE(naplaceno_iznos,0)) FILTER (WHERE naplaceno IS NOT TRUE AND COALESCE(stornirano,false)=false), 0) AS ocekivano_ukupno
        FROM proizvodnja_jopex
      `);
      naplacenoNalozi = parseFloat(rn.rows[0].naplaceno_ukupno) || 0;
      ocekivanoNalozi = parseFloat(rn.rows[0].ocekivano_ukupno) || 0;
    } catch (e) { /* tabela/kolona se možda razlikuje — ne rušimo cijelu rutu zbog ovoga */ }

    // Očekivano od maloprodaje — zbir svih neplaćenih/djelimično plaćenih otpremnica.
    // Konvertuje EUR PJ u KM-ekvivalent prije sabiranja (isti razlog kao gore).
    let ocekivanoMalo = 0;
    try {
      const filterMalo = req.blagajnikObjektIds
        ? `AND o.objekt_id = ANY($1::int[])`
        : '';
      const maloVals = req.blagajnikObjektIds ? [req.blagajnikObjektIds] : [];
      const rm = await pool.query(`
        SELECT COALESCE(SUM(
          CASE WHEN p.valuta = 'EUR' THEN (o.ukupan_iznos - o.iznos_placeno) * ${KURS_EUR_KM}
               ELSE (o.ukupan_iznos - o.iznos_placeno) END
        ),0) AS ukupno
        FROM otpremnice o
        LEFT JOIN prodajni_objekti p ON p.id = o.objekt_id
        WHERE o.status='potvrdjena' AND o.status_placanja != 'placeno' ${filterMalo}
      `, maloVals);
      ocekivanoMalo = parseFloat(rm.rows[0].ukupno) || 0;
    } catch (e) { /* isto — ne rušimo rutu ako tabela/kolona iz nekog razloga ne postoji */ }

    res.json({
      ...r.rows[0],
      nepredano_po_pj: nepredanoPoPJ,
      naplaceno_nalozi: naplacenoNalozi.toFixed(2),
      ocekivano_nalozi: ocekivanoNalozi.toFixed(2),
      ocekivano_malo: ocekivanoMalo.toFixed(2),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gotovina/nalog/:r_br - uplate za konkretan radni nalog (proizvodnja) — ovo
// nije PJ-vezano (blagajnik nema posla ovdje), pa ostaje isključivo admin.
router.get('/nalog/:r_br', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const r = await pool.query(
      'SELECT * FROM gotovina WHERE nalog_r_br=$1 ORDER BY datum DESC',
      [req.params.r_br]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gotovina - nova uplata
router.post('/', async (req, res) => {
  try {
    const { datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv } = req.body;
    if (!iznos || !primio) return res.status(400).json({ error: 'iznos i primio su obavezni.' });
    // Ovaj unos ide DIREKTNO od blagajnika (ili admina) koji fizički već ima taj novac —
    // nema "predaje" od nekog drugog, pa se odmah računa u "Trenutno u blagajni" (bez
    // čekanja da neko drugi to potvrdi). I dalje se vidi u listi za nadzor/reviziju.
    const r = await pool.query(
      `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv, predao_blagajniku, datum_predaje, preuzeo_ime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, now(), $3) RETURNING *`,
      [datum || new Date().toISOString().split('T')[0], iznos, primio,
       izvor || 'Proizvodnja', nalog_r_br || null, opis || null, objekt_naziv || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/gotovina/:id - ažuriranje (predao vlasniku)
router.patch('/:id', async (req, res) => {
  try {
    const { predao_blagajniku, datum_predaje, iznos, primio, datum, opis, izvor, nalog_r_br, objekt_naziv } = req.body;
    const sets = [], vals = [];
    let i = 1;
    const ALLOWED = ['predao_blagajniku','datum_predaje','iznos','primio','datum','opis','izvor','nalog_r_br','preuzeo_ime','objekt_naziv'];
    for (const k of ALLOWED) {
      if (k in req.body) { sets.push(`${k}=$${i++}`); vals.push(req.body[k]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nema polja.' });

    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE gotovina SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    const zapis = r.rows[0];

    res.json(zapis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/gotovina/:id
router.delete('/:id', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    await pool.query('DELETE FROM gotovina WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gotovina/:id/kontrola - blagajnik potvrđuje da je pregledao VP/Banka red
// (čist "pečat", ne mijenja stanje robe niti dug kupca — to već rade otpremnice).
router.post('/:id/kontrola', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  try {
    const r = await pool.query(
      `UPDATE gotovina SET blagajnik_kontrola=true, blagajnik_kontrola_ko_id=$1,
         blagajnik_kontrola_ko_ime=$2, blagajnik_kontrola_kada=now()
       WHERE id=$3 RETURNING *`,
      [user.id, user.ime_prezime, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gotovina/naplaceno-nalozi-detalji — struktura "Naplaćeno (nalozi)" — uključuje
// i naloge koji NISU u potpunosti naplaćeni ali IMAJU već primljen avans/djelimičnu
// naplatu (prikazuje TAJ primljeni deo, ne cijelu ugovorenu sumu za njih).
router.get('/naplaceno-nalozi-detalji', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const r = await pool.query(`
      SELECT r_br, narucilac, zadatak, naplaceno,
        CASE WHEN naplaceno IS TRUE THEN COALESCE(ugovorena_suma,0)
             ELSE COALESCE(avans,0) + COALESCE(naplaceno_iznos,0) END AS ugovorena_suma
      FROM proizvodnja_jopex
      WHERE COALESCE(stornirano,false) = false
        AND (COALESCE(naplaceno,false) = true OR COALESCE(avans,0) + COALESCE(naplaceno_iznos,0) > 0.01)
      ORDER BY ugovorena_suma DESC
      LIMIT 300
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gotovina/ocekivano-nalozi-detalji — struktura "Očekivano od naloga" — lista
// pojedinačnih naloga koji čine tu sumu, ISTA formula/filter kao sam zbir gore, tako da se
// uvijek slaže. Lijeno se učitava (poziva se SAMO kad korisnik klikne na karticu).
router.get('/ocekivano-nalozi-detalji', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const r = await pool.query(`
      SELECT r_br, narucilac, zadatak, ugovorena_suma, avans, naplaceno_iznos,
             GREATEST(COALESCE(ugovorena_suma,0) - COALESCE(avans,0) - COALESCE(naplaceno_iznos,0), 0) AS za_naplatu
      FROM proizvodnja_jopex
      WHERE COALESCE(naplaceno,false) = false AND COALESCE(stornirano,false) = false
        AND GREATEST(COALESCE(ugovorena_suma,0) - COALESCE(avans,0) - COALESCE(naplaceno_iznos,0), 0) > 0.01
      ORDER BY za_naplatu DESC
      LIMIT 300
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gotovina/ocekivano-malo-detalji — struktura "Očekivano od maloprodaje" — lista
// pojedinačnih otpremnica koje čine tu sumu.
router.get('/ocekivano-malo-detalji', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const filterMalo = req.blagajnikObjektIds ? `AND o.objekt_id = ANY($1::int[])` : '';
    const vals = req.blagajnikObjektIds ? [req.blagajnikObjektIds] : [];
    const r = await pool.query(`
      SELECT o.broj, o.objekt_naziv, o.kupac_naziv, o.datum, p.valuta,
             (o.ukupan_iznos - o.iznos_placeno) AS duguje
      FROM otpremnice o
      LEFT JOIN prodajni_objekti p ON p.id = o.objekt_id
      WHERE o.status='potvrdjena' AND o.status_placanja != 'placeno' ${filterMalo}
      ORDER BY (o.ukupan_iznos - o.iznos_placeno) DESC
      LIMIT 300
    `, vals);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
