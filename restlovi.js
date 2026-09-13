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
const geo = require('./geometrija');
const nest = require('./nesting');
const multer = require('multer');
const uvoz = require('./restlovi-uvoz');

const primiFajl = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/* ─────────────────────────── pomoćne funkcije ─────────────────────────── */

// Tjemena oblika: iz kolone 'poligon' ako postoji, inače iz A/B/C/D.
function tjemenaRestla(r) {
  if (r.poligon) {
    const p = typeof r.poligon === 'string' ? JSON.parse(r.poligon) : r.poligon;
    if (Array.isArray(p) && p.length >= 3) return p;
  }
  return geo.tjemenaOdMjera(r.oblik, r.dim_a, r.dim_b, r.dim_c, r.dim_d);
}

function povrsinaM2(oblik, a, b, c, d, poligon) {
  const t = poligon && poligon.length >= 3 ? poligon : geo.tjemenaOdMjera(oblik, a, b, c, d);
  return geo.povrsinaPoligona(t) / 1000000;
}

// Gdje komad staje u restl. Ako je zadat POLIGON komada, radi se uklapanje oblika u
// oblik (L u L, nepravilan u trapez…). Ako nije, ide brža provjera pravougaonika.
function gdjeStaje(r, w, h, rez, komadPoligon) {
  const restl = tjemenaRestla(r);
  if (Array.isArray(komadPoligon) && komadPoligon.length >= 3) {
    return geo.poligonStaje(restl, komadPoligon, rez);
  }
  return geo.komadStaje(restl, w, h, rez);
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

// Prekidač za zaključavanje lagera. Podrazumijevano je ZAKLJUČAN — ako reda u
// tabeli nema iz bilo kog razloga, ponašamo se kao da je zaključan, jer je tiho
// mijenjanje tuđeg lagera gora greška od nemijenjanja.
/* KLASA po veličini — apsolutno, u kvadratima, ne "pola table".
   Table nisu iste veličine, pa je pola table od 3,2×1,6 m sasvim drugi komad nego
   pola table od 2×1 m. Granice se čuvaju u postavkama, da se mijenjaju bez koda. */
let GRANICE_KLASA = null;

async function graniceKlasa() {
  if (GRANICE_KLASA) return GRANICE_KLASA;
  try {
    const r = await pool.query(
      `SELECT kljuc, vrijednost FROM restlovi_postavke WHERE kljuc IN ('klasa_a_min_m2','klasa_b_min_m2')`);
    const m = new Map(r.rows.map(x => [x.kljuc, Number(x.vrijednost)]));
    GRANICE_KLASA = { a: m.get('klasa_a_min_m2') || 1.5, b: m.get('klasa_b_min_m2') || 0.5 };
  } catch (e) { GRANICE_KLASA = { a: 1.5, b: 0.5 }; }
  return GRANICE_KLASA;
}

async function odrediKlasu(povrsinaM2) {
  const g = await graniceKlasa();
  const p = Number(povrsinaM2) || 0;
  return p >= g.a ? 'A' : (p >= g.b ? 'B' : 'C');
}

async function lagerZakljucan() {
  try {
    const r = await pool.query(`SELECT vrijednost FROM restlovi_postavke WHERE kljuc='lager_zakljucan'`);
    return !r.rows.length || r.rows[0].vrijednost !== '0';
  } catch (err) {
    return true;
  }
}

// Umanjuje (ili vraća, ako je m2 negativan) stanje na lageru za taj artikal i PJ,
// i ostavlja trag u roba_kretanja — isti obrazac kao nivelacija u roba.js.
// Vraća upozorenje umjesto greške ako artikal nije povezan ili ga nema u tom PJ,
// da unos restla nikad ne padne samo zbog lagera.
async function pomjeriLager(client, robaId, objektId, m2, opis, user) {
  const kvadrata = Math.abs(Number(m2) || 0);
  const skida = Number(m2) > 0;
  const rezultat = { primijenjeno: false, m2: kvadrata, skida, tekst: '', upozorenje: null };

  if (!robaId) {
    rezultat.tekst = 'Restl nije povezan sa artiklom iz lager liste — lager se ne mijenja.';
    return rezultat;
  }
  if (!kvadrata) return rezultat;

  const zakljucan = await lagerZakljucan();
  const kolicina = kvadrata.toFixed(2).replace('.', ',') + ' m²';

  if (zakljucan) {
    // Radnja se izvršava, ali lager ostaje netaknut — samo se najavljuje efekat.
    rezultat.tekst = 'Ovo bi ' + (skida ? 'skinulo ' : 'dodalo ') + kolicina +
                     (skida ? ' sa lagera' : ' na lager') + ' — lager je zaključan, stanje nije mijenjano.';
    return rezultat;
  }

  const rp = await client.query(
    'SELECT stanje FROM roba_pj WHERE roba_id=$1 AND objekt_id=$2 FOR UPDATE',
    [robaId, objektId]
  );
  if (!rp.rows.length) {
    rezultat.tekst = 'Artikal nije na lageru tog PJ — lager nije mijenjan.';
    return rezultat;
  }

  const staro = Number(rp.rows[0].stanje) || 0;
  const novo = staro - Number(m2);
  await client.query(
    'UPDATE roba_pj SET stanje=$1, azurirano=now() WHERE roba_id=$2 AND objekt_id=$3',
    [novo, robaId, objektId]
  );
  await client.query(
    `INSERT INTO roba_kretanja (roba_id, objekt_id, tip, kolicina, napomena, korisnik_id, korisnik_ime)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [robaId, objektId, skida ? 'izlaz' : 'ulaz', kvadrata, opis,
     user?.id || null, user?.ime_prezime || null]
  );

  rezultat.primijenjeno = true;
  rezultat.tekst = 'Ovo ' + (skida ? 'skida ' : 'dodaje ') + kolicina +
                   (skida ? ' sa lagera' : ' na lager') + ' — novo stanje ' +
                   novo.toFixed(2).replace('.', ',') + ' m².';
  if (novo < 0) rezultat.upozorenje = 'Pažnja: lager artikla je sada u minusu — provjeri stanje.';
  return rezultat;
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

// GET /api/restlovi/postavke — stanje prekidača, vidi ga svako ko ima pristup
router.get('/postavke', smijeVidjeti, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT vrijednost, azurirao_ime, azurirano FROM restlovi_postavke WHERE kljuc='lager_zakljucan'`);
    res.json({
      lager_zakljucan: !r.rows.length || r.rows[0].vrijednost !== '0',
      mijenjao: r.rows[0]?.azurirao_ime || null,
      kada: r.rows[0]?.azurirano || null,
      moze_mijenjati: req.session?.user?.rola === 'admin',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/restlovi/postavke/lager — otključavanje i zaključavanje, samo admin
router.put('/postavke/lager', async (req, res) => {
  const user = req.session?.user;
  if (user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin može otključati lager.' });
  try {
    const zakljucan = req.body.zakljucan !== false && req.body.zakljucan !== '0';
    await pool.query(
      `INSERT INTO restlovi_postavke (kljuc, vrijednost, azurirao_id, azurirao_ime, azurirano)
       VALUES ('lager_zakljucan',$1,$2,$3,now())
       ON CONFLICT (kljuc) DO UPDATE SET vrijednost=$1, azurirao_id=$2, azurirao_ime=$3, azurirano=now()`,
      [zakljucan ? '1' : '0', user.id, user.ime_prezime]
    );
    res.json({ ok: true, lager_zakljucan: zakljucan });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



/* ─────────────────────────── NESTING ───────────────────────────
   Raspoređivanje VIŠE komada u jednu ploču. Za razliku od /trazi, koja odgovara na
   pitanje "staje li jedan komad", ova ruta kaže KOLIKO komada stvarno izlazi iz
   restla i gdje tačno — pa se iz naloga dobija tačan broj umjesto procjene. */

// POST /api/restlovi/nesting
// body: { restl_id? | poligon? | sirina+visina?, komadi:[{sirina,visina,kolicina,naziv?,bez_okretanja?}], rez? }
router.post('/nesting', smijeVidjeti, async (req, res) => {
  try {
    const { restl_id, komadi, rez, dozvoli_koso } = req.body;
    if (!Array.isArray(komadi) || !komadi.length)
      return res.status(400).json({ error: 'Nema komada za raspoređivanje.' });

    // Ploča: postojeći restl, nacrtani oblik ili obične mjere
    let ploca = null, restl = null;
    if (restl_id) {
      const r = await pool.query(
        `SELECT r.*, ro.naziv AS artikal_naziv, ro.sifra AS artikal_sifra
           FROM restlovi r LEFT JOIN roba ro ON ro.id = r.roba_id WHERE r.id = $1`, [restl_id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Restl nije pronađen.' });
      restl = r.rows[0];
      ploca = tjemenaRestla(restl);
    } else if (Array.isArray(req.body.poligon) && req.body.poligon.length >= 3) {
      const g = geo.provjeriTjemena(req.body.poligon);
      if (g) return res.status(400).json({ error: 'Oblik ploče: ' + g });
      ploca = req.body.poligon;
    } else {
      const A = Number(req.body.sirina) || 0, B = Number(req.body.visina) || 0;
      if (!A || !B) return res.status(400).json({ error: 'Zadaj restl_id, poligon ili mjere ploče.' });
      ploca = [[0,0],[A,0],[A,B],[0,B]];
    }

    for (const k of komadi) {
      if (!Number(k.sirina) || !Number(k.visina))
        return res.status(400).json({ error: 'Svaki komad mora imati širinu i visinu.' });
    }

    const r = nest.rasporedi(ploca, komadi, { rez: Number(rez) || 0, dozvoli_koso: !!dozvoli_koso });

    // Rezultat se provjerava PRIJE slanja — raspored sa preklapanjem ne smije izaći
    const greske = nest.provjeriRaspored(ploca, r);
    if (greske.length) {
      return res.status(500).json({ error: 'Raspored nije ispravan: ' + greske.join('; ') });
    }

    res.json({
      ...r,
      ploca,
      restl: restl ? {
        id: restl.id, oznaka: restl.oznaka, materijal: restl.materijal,
        artikal_naziv: restl.artikal_naziv, artikal_sifra: restl.artikal_sifra,
        dim_a: restl.dim_a, dim_b: restl.dim_b, cijena_m2: restl.cijena_m2,
      } : null,
      vrijednost_iskoristeno: restl ? Math.round(r.iskoristeno * Number(restl.cijena_m2 || 0) * 100) / 100 : null,
      vrijednost_ostatak: restl ? Math.round(r.ostatak * Number(restl.cijena_m2 || 0) * 100) / 100 : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/restlovi/nesting/za-nalog
// Za cijelu listu pozicija odjednom: za svaku se probaju restlovi po redu i vrati se
// koliko komada STVARNO izlazi iz restlova, a koliko ostaje za cijelu tablu.
// body: { pozicije:[{id,sirina,visina,kolicina,roba_id?,materijal?,debljina_cm?}], rez?, objekt_id? }
router.post('/nesting/za-nalog', smijeVidjeti, async (req, res) => {
  try {
    const { pozicije, rez, objekt_id } = req.body;
    /* STRATEGIJA — "najbolje" zavisi od toga šta je u tom trenutku važnije:
       'najmanje_restlova'  → otvori što manje komada, i kad ostatak bude veći
       'najbolje_iskoristenje' → najmanje otpada po restlu, i ako treba više njih
       'cuvaj_velike'       → uzmi najmanji restl koji posao završava, veliki ostaju cijeli
       Sve tri daju ISPRAVAN plan; razlikuju se po tome šta žrtvuju. */
    const strategija = ['najmanje_restlova', 'najbolje_iskoristenje', 'cuvaj_velike']
      .includes(req.body.strategija) ? req.body.strategija : 'najmanje_restlova';
    if (!Array.isArray(pozicije) || !pozicije.length)
      return res.status(400).json({ error: 'Nema pozicija.' });

    const rezMm = Number(rez) || 5;
    const iskorisceni = new Set();       // restl se ne smije dvaput obećati

    /* Pozicije se GRUPIŠU po materijalu i debljini, pa se u jedan restl pakuju SVE
       pozicije iz iste grupe odjednom. Ranije je svaka pozicija tražila svoj restl,
       pa se dvije male nisu spajale u isti komad iako bi obje stale — a upravo to je
       glavna ušteda kod ostataka. */
    const pripremljene = pozicije.map((p, i) => {
      const sir = Number(p.sirina) || 0, vis = Number(p.visina) || 0;
      // Debljina zna stići u milimetrima iz naloga, a restlovi je vode u centimetrima
      let deb = p.debljina_cm != null ? Number(p.debljina_cm) : null;
      if (deb && deb > 10) deb = deb / 10;
      return {
        _i: i, id: p.id, naziv: p.naziv || ('poz. ' + (i + 1)),
        sirina: sir, visina: vis,
        kolicina: Math.max(1, Math.round(Number(p.kolicina) || 1)),
        roba_id: p.roba_id || null, materijal: p.materijal || null,
        // Kad je izabrano više artikala, pozicija se traži u SVIMA — plan onda uzme
        // onaj restl u kojem komad najbolje leži, umjesto da se bira unaprijed.
        kandidat_roba_ids: Array.isArray(p.kandidat_roba_ids) && p.kandidat_roba_ids.length
          ? p.kandidat_roba_ids : null,
        debljina_cm: deb, bez_okretanja: !!p.bez_okretanja,
        preostalo: Math.max(1, Math.round(Number(p.kolicina) || 1)),
        restlovi: [], nadjeno_po: null, pregledano: 0,
        greska: (!sir || !vis) ? 'nema mjere' : null,
      };
    });

    const kljucGrupe = p => [
      p.kandidat_roba_ids ? 'vise:' + p.kandidat_roba_ids.join(',')
                          : (p.roba_id || ('naziv:' + (p.materijal || ''))),
      p.debljina_cm || '',
    ].join('|');
    const grupe = new Map();
    for (const p of pripremljene) {
      if (p.greska) continue;
      const k = kljucGrupe(p);
      if (!grupe.has(k)) grupe.set(k, []);
      grupe.get(k).push(p);
    }

    for (const [, clanovi] of grupe) {
      const uzorak = clanovi[0];

      /* Tri kruga, od najuže ka najširem: restlovi često još nisu vezani za artikal,
         pa pretraga samo po roba_id vrati prazno iako komad postoji. */
      const krugovi = [];
      if (uzorak.kandidat_roba_ids)
        krugovi.push({ kako: 'izabrani artikli', roba_ids: uzorak.kandidat_roba_ids, deb: uzorak.debljina_cm });
      if (uzorak.roba_id)   krugovi.push({ kako: 'artikal', roba_id: uzorak.roba_id, deb: uzorak.debljina_cm });
      if (uzorak.materijal) krugovi.push({ kako: 'naziv', materijal: uzorak.materijal, deb: uzorak.debljina_cm });
      if (uzorak.debljina_cm) krugovi.push({ kako: 'samo debljina', deb: uzorak.debljina_cm });
      krugovi.push({ kako: 'samo mjere' });

      // Najmanja mjera koju bilo koja pozicija u grupi traži — predfilter za bazu
      const najmanjaSir = Math.min(...clanovi.map(c => Math.min(c.sirina, c.visina)));
      const najmanjaVis = Math.min(...clanovi.map(c => Math.max(c.sirina, c.visina)));

      for (const krug of krugovi) {
        if (clanovi.every(c => !c.preostalo)) break;

        const uslovi = [`r.status = 'dostupan'`];
        const vals = [];
        let i = 1;
        if (krug.roba_ids)  { uslovi.push(`r.roba_id = ANY($${i++}::int[])`); vals.push(krug.roba_ids); }
        if (krug.roba_id)   { uslovi.push(`r.roba_id = $${i++}`); vals.push(krug.roba_id); }
        if (krug.materijal) { uslovi.push(`(r.materijal ILIKE $${i} OR ro.naziv ILIKE $${i})`); vals.push(`%${krug.materijal}%`); i++; }
        if (krug.deb)       { uslovi.push(`COALESCE(r.debljina_cm, ro.debljina_cm) = $${i++}`); vals.push(krug.deb); }
        if (objekt_id)      { uslovi.push(`r.objekt_id = $${i++}`); vals.push(objekt_id); }
        uslovi.push(`GREATEST(r.dim_a, r.dim_b) >= $${i++}`); vals.push(najmanjaVis);
        uslovi.push(`LEAST(r.dim_a, r.dim_b) >= $${i++}`);    vals.push(najmanjaSir);

        const q = await pool.query(
          `SELECT r.*, po.naziv AS objekt_naziv, ro.naziv AS artikal_naziv, ro.sifra AS artikal_sifra
             FROM restlovi r
             LEFT JOIN prodajni_objekti po ON po.id = r.objekt_id
             LEFT JOIN roba ro ON ro.id = r.roba_id
            WHERE ${uslovi.join(' AND ')}
            ORDER BY r.povrsina ASC LIMIT 60`, vals);
        for (const c of clanovi) c.pregledano += q.rows.length;

        /* NAJBOLJI, ne prvi koji nešto primi.
           Ranije se išlo redom od najmanjeg restla i uzimao se svaki koji primi bar
           jedan komad — pa su dva komada koja bi stala u JEDAN restl završavala u dva,
           i drugi restl bi ostao iskorišćen na 25%. Sad se za svaki restl izračuna
           koliko komada prima, pa se bira onaj koji prima najviše; kad dva primaju
           isto, uzima se onaj koji ostavlja manji ostatak. */
        while (clanovi.some(c => c.preostalo)) {
          const komadi = clanovi.filter(c => c.preostalo).map(c => ({
            id: c.id, naziv: c.naziv, sirina: c.sirina, visina: c.visina,
            kolicina: c.preostalo, bez_okretanja: c.bez_okretanja,
          }));
          if (!komadi.length) break;

          let najbolji = null;
          for (const restl of q.rows) {
            if (iskorisceni.has(restl.id)) continue;
            const raspored = nest.rasporedi(tjemenaRestla(restl), komadi, { rez: rezMm });
            if (!raspored.uklopljeno) continue;
            let bolji;
            if (!najbolji) bolji = true;
            else if (strategija === 'najbolje_iskoristenje') {
              // Najmanje otpada — i po cijenu toga da se otvori više restlova
              bolji = raspored.procenat > najbolji.raspored.procenat ||
                (raspored.procenat === najbolji.raspored.procenat &&
                 raspored.uklopljeno > najbolji.raspored.uklopljeno);
            } else if (strategija === 'cuvaj_velike') {
              // Najmanji restl koji primi isto toliko komada — veliki ostaju cijeli
              const povNovi = geo.povrsinaPoligona(tjemenaRestla(restl)) / 1e6;
              const povStari = geo.povrsinaPoligona(tjemenaRestla(najbolji.restl)) / 1e6;
              bolji = raspored.uklopljeno > najbolji.raspored.uklopljeno ||
                (raspored.uklopljeno === najbolji.raspored.uklopljeno && povNovi < povStari);
            } else {
              // Najviše komada u isti restl, pa manji ostatak
              bolji = raspored.uklopljeno > najbolji.raspored.uklopljeno ||
                (raspored.uklopljeno === najbolji.raspored.uklopljeno &&
                 raspored.ostatak < najbolji.raspored.ostatak);
            }
            if (bolji) najbolji = { restl, raspored };
            if (strategija === 'najmanje_restlova' &&
                raspored.uklopljeno === komadi.reduce((z, k) => z + k.kolicina, 0) &&
                raspored.procenat >= 60) break;
          }
          if (!najbolji) break;

          const { restl, raspored } = najbolji;
          const poPoziciji = new Map();
          for (const post of raspored.postavljeni) {
            poPoziciji.set(post.id, (poPoziciji.get(post.id) || 0) + 1);
          }
          iskorisceni.add(restl.id);

          // Ostali restlovi koji bi TAKOĐE primili ove komade — druge mogućnosti
          const alternative = q.rows
            .filter(x => x.id !== restl.id && !iskorisceni.has(x.id))
            .slice(0, 12)
            .map(x => {
              const alt = nest.rasporedi(tjemenaRestla(x), komadi, { rez: rezMm });
              return alt.uklopljeno ? {
                restl_id: x.id, oznaka: x.oznaka, dim_a: x.dim_a, dim_b: x.dim_b,
                komada: alt.uklopljeno, procenat: alt.procenat, ostatak_m2: alt.ostatak,
                objekt_naziv: x.objekt_naziv,
              } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.komada - a.komada || a.ostatak_m2 - b.ostatak_m2)
            .slice(0, 4);

          for (const c of clanovi) {
            const koliko = poPoziciji.get(c.id) || 0;
            if (!koliko) continue;
            c.preostalo -= koliko;
            if (!c.nadjeno_po) c.nadjeno_po = krug.kako;
            c.restlovi.push({
              restl_id: restl.id, oznaka: restl.oznaka,
              roba_id: restl.roba_id,
              objekt_naziv: restl.objekt_naziv,
              artikal_naziv: restl.artikal_naziv, artikal_sifra: restl.artikal_sifra,
              materijal: restl.materijal,
              dim_a: restl.dim_a, dim_b: restl.dim_b,
              komada: koliko,
              procenat: raspored.procenat,
              ostatak_m2: raspored.ostatak,
              dijeli_sa: [...poPoziciji.keys()].filter(k => k !== c.id).length,
              ukupno_u_restlu: raspored.uklopljeno,
              alternative,
              postavljeni: raspored.postavljeni,
            });
          }
        }
      }
    }

    const izlaz = pripremljene.map(p => ({
      id: p.id, naziv: p.naziv, sirina: p.sirina, visina: p.visina, kolicina: p.kolicina,
      iz_restlova: p.kolicina - p.preostalo,
      treba_tabla: p.greska ? p.kolicina : p.preostalo,
      restlovi: p.restlovi,
      nadjeno_po: p.nadjeno_po,
      pregledano_restlova: p.pregledano,
      trazena_debljina: p.debljina_cm,
      greska: p.greska,
    }));

    res.json({
      pozicije: izlaz,
      strategija,
      sazetak: {
        ukupno_komada: izlaz.reduce((z, p) => z + p.kolicina, 0),
        iz_restlova:   izlaz.reduce((z, p) => z + p.iz_restlova, 0),
        treba_tabla:   izlaz.reduce((z, p) => z + p.treba_tabla, 0),
        restlova_u_planu: iskorisceni.size,
        // Ukupan ostatak koji plan ostavlja — mjerilo po kojem se opcije porede
        ostatak_m2: Math.round(izlaz.reduce((z, p) =>
          z + p.restlovi.reduce((y, r) => y + (Number(r.ostatak_m2) || 0), 0), 0) * 10000) / 10000,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─────────────────────────── UVOZ IZ XLSX ───────────────────────────
   Dva koraka. Prvi je PROBNI — fajl se pročita i provjeri, vrati se sažetak i
   spisak spornih redova, a u bazu ne ide ništa. Drugi je POTVRDA, koja prima
   ispravljene redove nazad i tek tada upisuje.

   Uvoz NIKAD ne dira lager. Restlovi koje uvozimo su ostaci ploča koje su ranije
   već skinute sa lagera, a lager kod nas ionako sadrži i cijele table i restlove —
   pa bi upis značio da tvrdimo kako je materijal potrošen dvaput. */

function samoAdmin(req, res, next) {
  if (req.session?.user?.rola !== 'admin') return res.status(403).json({ error: 'Uvoz može samo administrator.' });
  next();
}

// POST /api/restlovi/uvoz/probni — čitanje i provjera, bez ijednog upisa
router.post('/uvoz/probni', samoAdmin, primiFajl.single('fajl'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nije poslan fajl.' });
    const listovi = uvoz.listaListova(req.file.buffer);
    const { ime, redovi } = uvoz.citajList(req.file.buffer, req.body.list);
    const { greska, stavke } = uvoz.pripremi(redovi);
    if (greska) return res.status(400).json({ error: greska, listovi, list: ime });

    // Povezivanje na artikal ide preko šifre — jednim upitom za sve šifre odjednom
    const sifre = [...new Set(stavke.map(s => s.sifra).filter(Boolean))];
    const objektId = Number(req.body.objekt_id) || null;
    let poSifri = new Map();
    if (sifre.length) {
      const r = await pool.query(
        `SELECT ro.id, ro.sifra, ro.naziv, ro.grupa, ro.debljina_cm, ro.jed_mjera, rp.cijena
           FROM roba ro
           LEFT JOIN roba_pj rp ON rp.roba_id = ro.id AND rp.objekt_id = $2
          WHERE ro.sifra = ANY($1::text[])`,
        [sifre.map(String), objektId]
      );
      for (const a of r.rows) poSifri.set(String(a.sifra), a);
    }

    for (const st of stavke) {
      const a = st.sifra ? poSifri.get(String(st.sifra)) : null;
      st.roba_id = a ? a.id : null;
      st.artikal = a ? a.naziv : null;
      st.cijena_m2 = a && String(a.jed_mjera).toLowerCase() === 'm2' ? Number(a.cijena) || 0 : 0;

      // Šifra je glavni ključ: ako je upisana ali je nema na lageru, red ne prolazi.
      if (st.sifra && !a) {
        st.greske.push(`šifra ${st.sifra} ne postoji u lager listi — ispravi je ili preskoči red`);
        st.status = 'greska';
      }
      // Artikal je pouzdaniji od teksta u tabeli, pa dopunjava ono što nedostaje
      if (a) {
        if (!st.debljina_cm && a.debljina_cm) {
          st.debljina_cm = Number(a.debljina_cm);
          st.upozorenja.push(`debljina ${st.debljina_cm} cm preuzeta sa artikla`);
        }
        if (!st.materijal && a.grupa) st.materijal = a.grupa;
        if (String(a.jed_mjera).toLowerCase() !== 'm2')
          st.upozorenja.push(`artikal se vodi u "${a.jed_mjera}", ne u m² — cijena se ne preuzima`);
      }
      if (st.oblik === 'L-oblik')
        st.upozorenja.push('L-oblik: strana kraka se iz tabele ne vidi, uvozi se sa krakom desno — provjeri komad');
    }

    // Koliko uvezenih restlova već stoji u tom PJ — da se prije uvoza zna da li se
    // dodaje na postojeće ili zamjenjuje
    let postojeci = { ukupno: 0, netaknuti: 0, dirnuti: 0 };
    if (objektId) {
      const p = await pool.query(
        `SELECT COUNT(*)::int AS ukupno,
                COUNT(*) FILTER (WHERE status = 'dostupan'
                  AND NOT EXISTS (SELECT 1 FROM restl_koristenje k WHERE k.restl_id = r.id)
                  AND NOT EXISTS (SELECT 1 FROM restl_prenosi pr WHERE pr.restl_id = r.id)
                  AND NOT EXISTS (SELECT 1 FROM restlovi d WHERE d.roditelj_id = r.id))::int AS netaknuti
           FROM restlovi r WHERE r.uvoz_id IS NOT NULL AND r.objekt_id = $1`, [objektId]);
      postojeci.ukupno = p.rows[0].ukupno;
      postojeci.netaknuti = p.rows[0].netaknuti;
      postojeci.dirnuti = postojeci.ukupno - postojeci.netaknuti;
    }

    const sporni = stavke.filter(s => s.greske.length || s.upozorenja.length);
    res.json({
      postojeci,
      list: ime, listovi,
      sazetak: uvoz.sazetak(stavke),
      povezano: stavke.filter(s => s.roba_id).length,
      stavke, sporni_broj: sporni.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/restlovi/uvoz/potvrdi — upisuje ispravljene redove
router.post('/uvoz/potvrdi', samoAdmin, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    const { objekt_id, naziv_fajla, list, stavke } = req.body;
    /* NAČIN UVOZA — bez ovoga se svaki ponovni uvoz iste tabele nalijepi na postojeće
       stanje i restlovi se udvostruče.
         'dodaj'   — samo dodaje (prvi uvoz, ili dopuna novim komadima)
         'zamijeni'— prethodno uvezeni restlovi tog PJ se storniraju pa se uvozi novo
       Storniraju se SAMO netaknuti komadi — korišćeni ostaju, jer je njihova istorija
       stvarna i ne smije nestati. */
    const nacin = req.body.nacin === 'zamijeni' ? 'zamijeni' : 'dodaj';
    if (!objekt_id) return res.status(400).json({ error: 'PJ nije izabran.' });
    if (!Array.isArray(stavke) || !stavke.length) return res.status(400).json({ error: 'Nema redova za uvoz.' });

    const kandidati = stavke.filter(s => !s.preskoci && s.status !== 'prazan');

    // Šifra je glavni ključ, pa se veza gradi OVDJE, iz baze — ne iz onoga što je
    // stigao sa ekrana. Tako izmjena šifre u spisku spornih redova ima efekta,
    // a podmetnuti roba_id nema.
    const sifre = [...new Set(kandidati.map(s => String(s.sifra || '').trim()).filter(Boolean))];
    const poSifri = new Map();
    if (sifre.length) {
      const a = await pool.query(
        `SELECT ro.id, ro.sifra, ro.naziv, ro.grupa, ro.debljina_cm, ro.jed_mjera, rp.cijena
           FROM roba ro
           LEFT JOIN roba_pj rp ON rp.roba_id = ro.id AND rp.objekt_id = $2
          WHERE ro.sifra = ANY($1::text[])`, [sifre, objekt_id]);
      for (const x of a.rows) poSifri.set(String(x.sifra), x);
    }

    const odbijeni = [];
    const zaUpis = [];
    for (const s of kandidati) {
      const sifra = String(s.sifra || '').trim();
      const artikal = sifra ? poSifri.get(sifra) : null;
      if (!artikal) {
        odbijeni.push(`red ${s.red}: ` + (sifra ? `šifra ${sifra} ne postoji na lageru` : 'nema šifru'));
        continue;
      }
      // Zaštita od reda koji je ručno označen kao ispravljen, a nema oblik.
      // Bez ovoga bi ušao komad sa nultim mjerama.
      if (s.status !== 'potrosen' && (!Array.isArray(s.poligon) || s.poligon.length < 3)) {
        odbijeni.push(`red ${s.red}: nema upotrebljive mjere — oblik se ne može napraviti`);
        continue;
      }
      s.roba_id = artikal.id;
      s.cijena_m2 = String(artikal.jed_mjera).toLowerCase() === 'm2' ? Number(artikal.cijena) || 0 : 0;
      if (!s.debljina_cm && artikal.debljina_cm) s.debljina_cm = Number(artikal.debljina_cm);
      if (!s.materijal && artikal.grupa) s.materijal = artikal.grupa;
      if (!s.tip && artikal.naziv) s.tip = artikal.naziv;
      zaUpis.push(s);
    }

    const preskoceno = stavke.length - zaUpis.length;
    if (!zaUpis.length) {
      return res.status(400).json({
        error: 'Nijedan red nema upotrebljivu šifru. ' + odbijeni.slice(0, 5).join('; '),
      });
    }

    await client.query('BEGIN');

    let obrisano = 0, zadrzano = [];
    if (nacin === 'zamijeni') {
      // Komadi koji su korišćeni, prenošeni ili od kojih je nastao drugi restl se NE
      // brišu — njihov trag je stvaran. Ostaju i broje se posebno.
      const dirnuti = await client.query(
        `SELECT r.id, r.oznaka FROM restlovi r
          WHERE r.uvoz_id IS NOT NULL AND r.objekt_id = $1 AND (
                r.status <> 'dostupan'
             OR EXISTS (SELECT 1 FROM restl_koristenje k WHERE k.restl_id = r.id)
             OR EXISTS (SELECT 1 FROM restl_prenosi p WHERE p.restl_id = r.id)
             OR EXISTS (SELECT 1 FROM restlovi d WHERE d.roditelj_id = r.id)
             OR EXISTS (SELECT 1 FROM nalog_materijal nm WHERE nm.restl_id = r.id AND nm.stornirano = false))`,
        [objekt_id]);
      zadrzano = dirnuti.rows.map(x => x.oznaka);
      const zadrzaniIds = dirnuti.rows.map(x => x.id);

      const zaBrisanje = await client.query(
        `SELECT id FROM restlovi
          WHERE uvoz_id IS NOT NULL AND objekt_id = $1
            AND NOT (id = ANY($2::int[]))`,
        [objekt_id, zadrzaniIds.length ? zadrzaniIds : [0]]);
      const ids = zaBrisanje.rows.map(x => x.id);
      if (ids.length) {
        await client.query('DELETE FROM restl_log WHERE restl_id = ANY($1::int[])', [ids]);
        const d = await client.query('DELETE FROM restlovi WHERE id = ANY($1::int[])', [ids]);
        obrisano = d.rowCount;
      }
      // Stare serije se označe stornirano, da se u istoriji vidi šta je zamijenjeno
      await client.query(
        `UPDATE restl_uvoz SET stornirano=true, stornirao_ime=$1, stornirano_kada=now()
          WHERE objekt_id=$2 AND stornirano=false`,
        [user.ime_prezime + ' (zamjena uvozom)', objekt_id]);
    }

    const serija = await client.query(
      `INSERT INTO restl_uvoz (naziv_fajla, list, objekt_id, korisnik_id, korisnik_ime, preskoceno)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [naziv_fajla || null, list || null, objekt_id, user.id, user.ime_prezime, preskoceno]
    );
    const uvozId = serija.rows[0].id;

    // Oznake se dodjeljuju u nizu, jednim čitanjem posljednje — bez upita po redu
    const god = new Date().getFullYear();
    const zadnja = await client.query(
      `SELECT oznaka FROM restlovi WHERE oznaka LIKE $1 ORDER BY oznaka DESC LIMIT 1`, [`R-${god}-%`]);
    let brojac = zadnja.rows.length ? parseInt(zadnja.rows[0].oznaka.split('-')[2], 10) : 0;

    const redoviZaUpis = [];
    for (const st of zaUpis) {
      const komada = Math.max(1, Number(st.kom) || 1);
      for (let i = 0; i < komada; i++) {
        brojac++;
        redoviZaUpis.push({
          oznaka: `R-${god}-${String(brojac).padStart(4, '0')}`,
          objekt_id, roba_id: st.roba_id || null,
          materijal: st.tip || st.materijal || '(bez naziva)',
          grupa: st.materijal || null,
          debljina_cm: st.debljina_cm || null,
          oblik: st.status === 'potrosen' ? 'pravougaonik' : (st.oblik === 'L-oblik' ? 'poligon' : 'pravougaonik'),
          poligon: st.poligon ? JSON.stringify(st.poligon) : null,
          dim_a: st.sirina || 0, dim_b: st.visina || 0,
          povrsina: st.povrsina || 0,
          cijena_m2: Number(st.cijena_m2) || 0,
          lokacija: st.lokacija || null,
          nastao_iz_naloga: st.nalog || null,
          napomena: [st.napomena, st.rbr ? `iz tabele, r.br ${st.rbr}` : null].filter(Boolean).join(' · '),
          status: st.status === 'potrosen' ? 'potrosen' : 'dostupan',
          treba_provjeriti: st.oblik === 'L-oblik',
          izvorni_rbr: String(st.rbr || ''),
        });
      }
    }

    // Upis u grupama od po 200 redova — jedan upit po grupi umjesto po komadu
    let upisano = 0, ukupnaPovrsina = 0;
    for (let p = 0; p < redoviZaUpis.length; p += 200) {
      const grupa = redoviZaUpis.slice(p, p + 200);
      const vals = [];
      const mjesta = grupa.map((r, i) => {
        const b = i * 18;
        vals.push(r.oznaka, r.objekt_id, r.roba_id, r.materijal, r.grupa, r.debljina_cm,
                  r.oblik, r.poligon, r.dim_a, r.dim_b, r.povrsina, r.cijena_m2,
                  r.lokacija, r.nastao_iz_naloga, r.napomena, r.status, r.treba_provjeriti, r.izvorni_rbr);
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8}::jsonb,$${b+9},$${b+10},
                 $${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18},
                 ${uvozId}, 'tabla', ${user.id}, '${String(user.ime_prezime).replace(/'/g, "''")}')`;
      }).join(',');
      const r = await client.query(
        `INSERT INTO restlovi
           (oznaka, objekt_id, roba_id, materijal, grupa, debljina_cm, oblik, poligon,
            dim_a, dim_b, povrsina, cijena_m2, lokacija, nastao_iz_naloga, napomena, status,
            treba_provjeriti, izvorni_rbr, uvoz_id, izvor, kreirao_id, kreirao_ime)
         VALUES ${mjesta} RETURNING povrsina`, vals);
      upisano += r.rowCount;
      for (const x of r.rows) ukupnaPovrsina += Number(x.povrsina) || 0;
    }

    await client.query(
      `UPDATE restl_uvoz SET redova=$1, komada=$2, povrsina=$3 WHERE id=$4`,
      [zaUpis.length, upisano, ukupnaPovrsina, uvozId]);

    await client.query('COMMIT');
    res.json({
      ok: true, uvoz_id: uvozId, redova: zaUpis.length, komada: upisano,
      povrsina: Math.round(ukupnaPovrsina * 10000) / 10000, preskoceno,
      odbijeni: odbijeni.slice(0, 20), odbijenih: odbijeni.length,
      nacin, obrisano,
      zadrzano: zadrzano.slice(0, 30), zadrzanih: zadrzano.length,
      napomena: 'Lager nije mijenjan — uvoz nikad ne dira lager listu.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/restlovi/uvoz/prijedlog — koji PJ ponuditi.
// Ništa nije upisano u kod: prvo se gleda gdje je zadnji put uvoženo, pa gdje već
// ima najviše restlova. Ako baza nema ništa, ne predlaže se ništa.
router.get('/uvoz/prijedlog', samoAdmin, async (req, res) => {
  try {
    const zadnji = await pool.query(
      `SELECT u.objekt_id, po.naziv FROM restl_uvoz u
         LEFT JOIN prodajni_objekti po ON po.id = u.objekt_id
        WHERE u.stornirano = false ORDER BY u.kada DESC LIMIT 1`);
    if (zadnji.rows.length) {
      return res.json({ objekt_id: zadnji.rows[0].objekt_id, naziv: zadnji.rows[0].naziv,
                        razlog: 'ovdje je bio posljednji uvoz' });
    }
    const najvise = await pool.query(
      `SELECT r.objekt_id, po.naziv, COUNT(*)::int AS koliko FROM restlovi r
         LEFT JOIN prodajni_objekti po ON po.id = r.objekt_id
        GROUP BY r.objekt_id, po.naziv ORDER BY koliko DESC LIMIT 1`);
    if (najvise.rows.length) {
      return res.json({ objekt_id: najvise.rows[0].objekt_id, naziv: najvise.rows[0].naziv,
                        razlog: `ovdje već ima ${najvise.rows[0].koliko} restlova` });
    }
    res.json({ objekt_id: null, naziv: null, razlog: null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/restlovi/uvoz/serije — istorija uvoza
router.get('/uvoz/serije', samoAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.*, po.naziv AS objekt_naziv,
              (SELECT COUNT(*) FROM restlovi WHERE uvoz_id = u.id) AS ostalo
         FROM restl_uvoz u LEFT JOIN prodajni_objekti po ON po.id = u.objekt_id
        ORDER BY u.kada DESC LIMIT 50`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/restlovi/uvoz/:id/storniraj — briše SAMO netaknute komade iz te serije
router.post('/uvoz/:id/storniraj', samoAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT * FROM restl_uvoz WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!u.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Uvoz nije pronađen.' }); }
    if (u.rows[0].stornirano) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Već je stornirano.' }); }

    // Komad koji je već korišćen, prenesen ili je od njega nastao drugi restl se NE briše
    const dirnuti = await client.query(
      `SELECT r.oznaka FROM restlovi r
        WHERE r.uvoz_id = $1 AND (
              EXISTS (SELECT 1 FROM restl_koristenje k WHERE k.restl_id = r.id)
           OR EXISTS (SELECT 1 FROM restl_prenosi p WHERE p.restl_id = r.id)
           OR EXISTS (SELECT 1 FROM restlovi d WHERE d.roditelj_id = r.id))`,
      [req.params.id]);
    if (dirnuti.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Ne može: ${dirnuti.rows.length} komada iz ovog uvoza je već u upotrebi ` +
               `(${dirnuti.rows.slice(0, 5).map(x => x.oznaka).join(', ')}${dirnuti.rows.length > 5 ? '…' : ''}). ` +
               `Prvo storniraj njihova korišćenja.`,
      });
    }

    await client.query('DELETE FROM restl_log WHERE restl_id IN (SELECT id FROM restlovi WHERE uvoz_id=$1)', [req.params.id]);
    const obrisano = await client.query('DELETE FROM restlovi WHERE uvoz_id=$1', [req.params.id]);
    await client.query(
      `UPDATE restl_uvoz SET stornirano=true, stornirao_ime=$1, stornirano_kada=now() WHERE id=$2`,
      [req.session.user.ime_prezime, req.params.id]);

    await client.query('COMMIT');
    res.json({ ok: true, obrisano: obrisano.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
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
              rod.oznaka AS roditelj_oznaka,
              ro.sifra AS artikal_sifra, ro.naziv AS artikal_naziv,
              COALESCE(r.grupa, ro.grupa) AS prikaz_grupa,
              COALESCE(r.debljina_cm, ro.debljina_cm) AS prikaz_debljina,
              (SELECT mg.naziv FROM master_grupe mg
                 WHERE mg.id = COALESCE(ro.master_grupa_id,
                       (SELECT gm.master_grupa_id FROM grupa_master gm WHERE gm.grupa = COALESCE(r.grupa, ro.grupa)))
                ) AS master_grupa,
              (SELECT COALESCE(thumb_url, url) FROM roba_slike WHERE roba_id = ro.id AND glavna = true LIMIT 1) AS slika
         FROM restlovi r
         LEFT JOIN prodajni_objekti po ON po.id = r.objekt_id
         LEFT JOIN restlovi rod ON rod.id = r.roditelj_id
         LEFT JOIN roba ro ON ro.id = r.roba_id
        ${uslovi.length ? 'WHERE ' + uslovi.join(' AND ') : ''}
        ORDER BY r.kreirano DESC
        LIMIT 500`,
      vals
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/restlovi/filteri — grupe, debljine i artikli koji STVARNO imaju restlove.
// Izvor je lager lista (roba), da se koriste iste grupe kao u magacinu.
router.get('/filteri', smijeVidjeti, async (req, res) => {
  try {
    const [grupe, artikli] = await Promise.all([
      // SVI dostupni restlovi, ne samo oni bez veze — grupa i debljina se uzimaju
      // sa restla ili sa artikla, šta god postoji. Ranije je ovaj upit hvatao samo
      // restlove bez veze KOJI IMAJU grupu, pa su meniji ostajali prazni sve dok se
      // ne uradi usaglašavanje.
      pool.query(
        `SELECT DISTINCT COALESCE(r.grupa, ro.grupa) AS grupa,
                COALESCE(r.debljina_cm, ro.debljina_cm) AS debljina_cm,
                COALESCE(NULLIF(r.materijal, ''), ro.naziv) AS materijal,
                (SELECT mg.naziv FROM master_grupe mg
                  WHERE mg.id = COALESCE(ro.master_grupa_id,
                        (SELECT gm.master_grupa_id FROM grupa_master gm WHERE gm.grupa = COALESCE(r.grupa, ro.grupa)))
                ) AS master_grupa
           FROM restlovi r LEFT JOIN roba ro ON ro.id = r.roba_id
          WHERE r.status = 'dostupan'`),
      // Master grupa se računa u UNUTRAŠNJEM upitu, gdje r.grupa još postoji kao
      // običan red. Da je podupit ostao u vanjskom SELECT-u, PostgreSQL bi ga odbio
      // jer r.grupa tamo nije u GROUP BY nego samo unutar COALESCE.
      pool.query(
        `SELECT id, sifra, naziv, grupa, master_grupa, debljina_cm,
                COUNT(*)::int AS restlova,
                COALESCE(SUM(povrsina), 0) AS m2,
                MAX(slika) AS slika
           FROM (
             SELECT ro.id, ro.sifra, ro.naziv,
                    COALESCE(r.grupa, ro.grupa) AS grupa,
                    COALESCE(r.debljina_cm, ro.debljina_cm) AS debljina_cm,
                    r.povrsina,
                    (SELECT mg.naziv FROM master_grupe mg
                      WHERE mg.id = COALESCE(ro.master_grupa_id,
                            (SELECT gm.master_grupa_id FROM grupa_master gm
                              WHERE gm.grupa = COALESCE(r.grupa, ro.grupa)))) AS master_grupa,
                    (SELECT COALESCE(thumb_url, url) FROM roba_slike
                      WHERE roba_id = ro.id AND glavna = true LIMIT 1) AS slika
               FROM roba ro
               JOIN restlovi r ON r.roba_id = ro.id AND r.status = 'dostupan'
           ) x
          GROUP BY id, sifra, naziv, grupa, master_grupa, debljina_cm
          ORDER BY naziv`),
    ]);
    // Parovi grupa+debljina koji STVARNO postoje — na osnovu njih se filteri
    // međusobno sužavaju, umjesto da se nude kombinacije kojih nema.
    const parovi = artikli.rows.map(a => ({
      master: a.master_grupa || null,
      grupa: a.grupa || null,
      debljina: a.debljina_cm != null ? Number(a.debljina_cm) : null,
    })).concat(grupe.rows.map(x => ({
      master: x.master_grupa || null,
      grupa: x.grupa || null,
      debljina: x.debljina_cm != null ? Number(x.debljina_cm) : null,
    })));

    res.json({
      master_grupe: [...new Set(parovi.map(x => x.master).filter(Boolean))].sort(),
      grupe: [...new Set(parovi.map(x => x.grupa).filter(Boolean))].sort(),
      debljine: [...new Set(parovi.map(x => x.debljina).filter(x => x))].sort((a, b) => a - b),
      // Nazivi materijala sa restlova koji još nemaju artikal — da se i oni mogu
      // izabrati iz menija umjesto da se kucaju napamet.
      materijali: [...new Set(grupe.rows.map(x => x.materijal).filter(Boolean))].sort(),
      parovi,
      artikli: artikli.rows,
      ukupno_dostupnih: grupe.rows.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/restlovi/usaglasi — poređenje restlova sa lager listom.
// Ništa ne mijenja, samo pokazuje gdje veza fali ili se podaci razilaze.
router.get('/usaglasi/pregled', smijeVidjeti, async (req, res) => {
  try {
    const [bezVeze, razlike, poArtiklu] = await Promise.all([
      pool.query(
        `SELECT id, oznaka, materijal, grupa, debljina_cm, povrsina, izvorni_rbr
           FROM restlovi WHERE roba_id IS NULL AND status <> 'potrosen'
          ORDER BY oznaka LIMIT 200`),
      pool.query(
        `SELECT r.id, r.oznaka, r.grupa AS restl_grupa, ro.grupa AS artikal_grupa,
                r.debljina_cm AS restl_debljina, ro.debljina_cm AS artikal_debljina,
                ro.sifra, ro.naziv AS artikal_naziv
           FROM restlovi r JOIN roba ro ON ro.id = r.roba_id
          WHERE r.status <> 'potrosen'
            AND ((r.grupa IS DISTINCT FROM ro.grupa AND r.grupa IS NOT NULL)
              OR (r.debljina_cm IS DISTINCT FROM ro.debljina_cm AND r.debljina_cm IS NOT NULL))
          ORDER BY r.oznaka LIMIT 200`),
      pool.query(
        `SELECT ro.sifra, ro.naziv, ro.grupa, ro.debljina_cm,
                COUNT(r.id)::int AS restlova, COALESCE(SUM(r.povrsina),0) AS restl_m2,
                COALESCE(MAX(rp.stanje), 0) AS lager_stanje
           FROM roba ro
           JOIN restlovi r ON r.roba_id = ro.id AND r.status = 'dostupan'
           LEFT JOIN roba_pj rp ON rp.roba_id = ro.id AND rp.objekt_id = r.objekt_id
          GROUP BY ro.sifra, ro.naziv, ro.grupa, ro.debljina_cm
          ORDER BY restl_m2 DESC`),
    ]);
    res.json({ bez_veze: bezVeze.rows, razlike: razlike.rows, po_artiklu: poArtiklu.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/restlovi/usaglasi/preuzmi — restlovi preuzimaju grupu i debljinu od
// svog artikla. Radi SAMO tamo gdje restl nema svoju vrijednost, osim ako se
// izričito traži prepisivanje. Lager se ne dira.
router.post('/usaglasi/preuzmi', smijeUnositi, async (req, res) => {
  const client = await pool.connect();
  try {
    const prepisi = req.body.prepisi === true;
    await client.query('BEGIN');
    const r = await client.query(
      prepisi
        ? `UPDATE restlovi r SET grupa = ro.grupa, debljina_cm = ro.debljina_cm
             FROM roba ro WHERE ro.id = r.roba_id AND r.status <> 'potrosen'
              AND (r.grupa IS DISTINCT FROM ro.grupa OR r.debljina_cm IS DISTINCT FROM ro.debljina_cm)
            RETURNING r.id`
        : `UPDATE restlovi r SET grupa = COALESCE(r.grupa, ro.grupa),
                                 debljina_cm = COALESCE(r.debljina_cm, ro.debljina_cm)
             FROM roba ro WHERE ro.id = r.roba_id AND r.status <> 'potrosen'
              AND (r.grupa IS NULL OR r.debljina_cm IS NULL)
            RETURNING r.id`);
    await client.query('COMMIT');
    res.json({ ok: true, azurirano: r.rowCount,
               napomena: 'Lager nije mijenjan — preuzeti su samo opisni podaci artikla.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/restlovi/trazi — GLAVNA RUTA: "da li imam restl za ovaj komad?"
// body: { sirina, visina, materijal, objekt_id?, rez?, debljina_cm?, grupa? }
// Vraća kandidate (best-fit prvo). Ako ih nema — prijedlog: cijela tabla sa lagera.
router.post('/trazi', smijeVidjeti, async (req, res) => {
  try {
    const { sirina, visina, materijal, objekt_id, rez, debljina_cm, grupa, poligon } = req.body;
    const jePoligon = Array.isArray(poligon) && poligon.length >= 3;

    // Kad je komad nacrtan, širina i visina se izvode iz njegovog okvira
    let sir = Number(sirina) || 0, vis = Number(visina) || 0;
    if (jePoligon) {
      const greska = geo.provjeriTjemena(poligon);
      if (greska) return res.status(400).json({ error: 'Oblik komada: ' + greska });
      const o = geo.okvir(poligon);
      sir = o.sirina; vis = o.visina;
    }
    if (!sir || !vis) return res.status(400).json({ error: 'Unesi mjere komada ili ga nacrtaj.' });

    const uslovi = [`r.status = 'dostupan'`];
    const vals = [];
    let i = 1;
    // Šifra artikla je ključ — kad je zadata, ostali filteri nisu potrebni jer
    // artikal već nosi grupu, debljinu i naziv.
    if (req.body.roba_id) { uslovi.push(`r.roba_id = $${i++}`); vals.push(req.body.roba_id); }
    else if (req.body.sifra) { uslovi.push(`ro.sifra = $${i++}`); vals.push(String(req.body.sifra).trim()); }
    else {
      if (materijal) { uslovi.push(`(r.materijal ILIKE $${i} OR ro.naziv ILIKE $${i})`); vals.push(`%${materijal}%`); i++; }
    }
    if (objekt_id) { uslovi.push(`r.objekt_id = $${i++}`); vals.push(objekt_id); }
    // Grupa i debljina se gledaju i na restlu i na artiklu — stari uvezeni restlovi
    // često nemaju svoje, ali imaju vezu na artikal koji ih ima.
    if (debljina_cm) { uslovi.push(`COALESCE(r.debljina_cm, ro.debljina_cm) = $${i++}`); vals.push(debljina_cm); }
    if (grupa)       { uslovi.push(`COALESCE(r.grupa, ro.grupa) = $${i++}`); vals.push(grupa); }
    // Master grupa je nadređena grupi. Izuzetak upisan na artiklu (roba.master_grupa_id)
    // ima prednost nad pravilom koje važi za cijelu grupu.
    if (req.body.master_grupa) {
      uslovi.push(`(SELECT mg.naziv FROM master_grupe mg
                     WHERE mg.id = COALESCE(ro.master_grupa_id,
                           (SELECT gm.master_grupa_id FROM grupa_master gm WHERE gm.grupa = COALESCE(r.grupa, ro.grupa)))) = $${i++}`);
      vals.push(req.body.master_grupa);
    }

    // Predfilter u bazi (grubo, po najvećoj mjeri) da ne vučemo cijelu tabelu,
    // pa precizna provjera oblika u JS-u.
    // Predfilter je namjerno labaviji za 'popust' milimetara, da kroz njega prođu i
    // restlovi kojima malo fali — inače bi ispali prije nego što ih uopšte izmjerimo.
    const popust = Math.max(0, Number(req.body.odstupanje) || 100);
    const min = Math.min(sir, vis);
    const max = Math.max(sir, vis);
    uslovi.push(`GREATEST(r.dim_a, r.dim_b) >= $${i++}`); vals.push(Math.max(0, max - popust));
    uslovi.push(`LEAST(r.dim_a, r.dim_b) >= $${i++}`);    vals.push(Math.max(0, min - popust));

    const q = await pool.query(
      `SELECT r.*, po.naziv AS objekt_naziv,
              ro.sifra AS artikal_sifra, ro.naziv AS artikal_naziv,
              COALESCE(r.grupa, ro.grupa) AS prikaz_grupa,
              COALESCE(r.debljina_cm, ro.debljina_cm) AS prikaz_debljina,
              ro.jed_mjera,
              (SELECT mg.naziv FROM master_grupe mg
                 WHERE mg.id = COALESCE(ro.master_grupa_id,
                       (SELECT gm.master_grupa_id FROM grupa_master gm WHERE gm.grupa = COALESCE(r.grupa, ro.grupa)))
                ) AS master_grupa,
              (SELECT COALESCE(thumb_url, url) FROM roba_slike WHERE roba_id = ro.id AND glavna = true LIMIT 1) AS slika
         FROM restlovi r
         LEFT JOIN prodajni_objekti po ON po.id = r.objekt_id
         LEFT JOIN roba ro ON ro.id = r.roba_id
        WHERE ${uslovi.join(' AND ')}
        LIMIT 300`,
      vals
    );

    // Površina komada: kod nacrtanog oblika stvarna, kod pravougaonika iz mjera
    const povrsinaKomada = jePoligon
      ? geo.povrsinaPoligona(poligon) / 1e6
      : (sir * vis) / 1e6;

    // Provjera pod svim uglovima je skupa (do ~40 ms po restlu u najgorem slučaju),
    // pa se prvo sortira po površini — najizgledniji idu prvi — i mjeri se najviše 60.
    const zaMjerenje = jePoligon
      ? q.rows.map(r => ({ r, d: Math.abs(Number(r.povrsina) - (geo.povrsinaPoligona(poligon) / 1e6)) }))
              .sort((a, b) => a.d - b.d).slice(0, 60).map(x => x.r)
      : q.rows;

    const kandidati = zaMjerenje
      .map(r => ({ r, poz: gdjeStaje(r, sir, vis, rez, jePoligon ? poligon : null) }))
      .filter(x => x.poz)
      .map(({ r, poz }) => ({
        ...r,
        otpad_m2: Math.max(0, Number(r.povrsina) - povrsinaKomada),
        polozaj: poz,
      }))
      .sort((a, b) => a.otpad_m2 - b.otpad_m2)
      .slice(0, 20);

    const opisKomada = { sirina: sir, visina: vis, povrsina: povrsinaKomada };
    if (kandidati.length) return res.json({ ima: true, kandidati, komad: opisKomada });

    /* ── NIŠTA NE STAJE: tražimo najbliže ──
       Restl se u koracima naduva i gleda se pri kojem bi komad ušao. Tako dobijamo
       koliko tačno milimetara fali — često je to par milimetara i majstor sam odluči
       hoće li smanjiti rezervu ili skratiti komad. */
    const dozvoljeno = Math.max(0, Number(req.body.odstupanje) || 100);
    const koraci = [5, 10, 20, 30, 50, 100].filter(k => k <= dozvoljeno);
    const komadZaMjeru = jePoligon ? poligon : [[0,0],[sir,0],[sir,vis],[0,vis]];

    const priblizni = q.rows
      // najprije oni koji su po površini najbliži — da ne mjerimo sve redom
      .map(r => ({ r, razlika: Math.abs(Number(r.povrsina) - povrsinaKomada) }))
      .sort((a, b) => a.razlika - b.razlika)
      .slice(0, 40)
      .map(({ r }) => {
        const f = geo.kolikoFali(tjemenaRestla(r), komadZaMjeru, rez, koraci);
        return f ? { ...r, fali_mm: f.fali, polozaj: f.polozaj, otpad_m2: Math.max(0, Number(r.povrsina) - povrsinaKomada) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.fali_mm - b.fali_mm || a.otpad_m2 - b.otpad_m2)
      .slice(0, 10);

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
    res.json({ ima: false, kandidati: [], priblizni, table: table.rows, komad: opisKomada });
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
      roditelj_id, nastao_iz_naloga, izvor, lokacija, napomena,
      umanji_lager_m2, poligon
    } = req.body;

    if (!objekt_id) return res.status(400).json({ error: 'PJ (objekt_id) je obavezan.' });
    if (!materijal) return res.status(400).json({ error: 'Materijal je obavezan.' });
    if (oblik !== 'poligon' && (!dim_a || !dim_b))
      return res.status(400).json({ error: 'Mjere A i B su obavezne.' });
    const ob = ['L', 'poligon'].includes(oblik) ? oblik : 'pravougaonik';
    if (ob === 'L' && (!dim_c || !dim_d)) return res.status(400).json({ error: 'Za L-oblik su obavezne i mjere C i D.' });

    // Proizvoljan oblik (trapez, kosi rez): tjemena su izvor istine, a A i B se
    // izvedu kao granični pravougaonik — tako predfilter u pretrazi i dalje radi.
    let tjemena = null;
    if (ob === 'poligon') {
      tjemena = Array.isArray(poligon) ? poligon.map(p => [Number(p[0]), Number(p[1])]) : null;
      const greska = geo.provjeriTjemena(tjemena || []);
      if (greska) return res.status(400).json({ error: greska });
    } else {
      tjemena = geo.tjemenaOdMjera(ob, dim_a, dim_b, dim_c, dim_d);
    }
    const okv = geo.okvir(tjemena);
    const A = ob === 'poligon' ? okv.sirina : dim_a;
    const B = ob === 'poligon' ? okv.visina : dim_b;

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
    const pov = povrsinaM2(ob, A, B, dim_c, dim_d, tjemena);
    const klasa = await odrediKlasu(pov);

    const r = await client.query(
      `INSERT INTO restlovi
         (oznaka, objekt_id, roba_id, materijal, grupa, debljina_cm, oblik,
          dim_a, dim_b, dim_c, dim_d, poligon, povrsina, cijena_m2, foto_url,
          roditelj_id, nastao_iz_naloga, izvor, lokacija, napomena,
          kreirao_id, kreirao_ime, klasa, stanje_komada, mane, korisna_povrsina)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               $23,$24,$25::jsonb,$26)
       RETURNING *`,
      [oznaka, objekt_id, roba_id || null, materijal, grupa || null, debljina_cm || null, ob,
       A, B, dim_c || 0, dim_d || 0, JSON.stringify(tjemena), pov, cijena, foto_url || null,
       roditelj_id || null, nastao_iz_naloga || null,
       izvor || (roditelj_id ? 'restl' : 'tabla'), lokacija || null, napomena || null,
       user.id, user.ime_prezime,
       klasa,
       ['ispravan','sa_manom','za_sitno'].includes(req.body.stanje_komada) ? req.body.stanje_komada : 'ispravan',
       Array.isArray(req.body.mane) && req.body.mane.length ? JSON.stringify(req.body.mane) : null,
       // Kad mana smanjuje upotrebljivost, korisna površina je manja od stvarne —
       // pošteno je voditi komad kao manji nego se praviti da je cio upotrebljiv.
       Number(req.body.korisna_povrsina) || null]
    );

    await upisiLog(client, r.rows[0].id, 'kreiran', null, oznaka, user);

    // Rezanje CIJELE TABLE: sa lagera odlazi isječeni komad + otpad. Sam restl OSTAJE
    // na lageru (fizički je i dalje u magacinu), pa se on NE skida.
    let lager = null;
    const skini = Number(umanji_lager_m2) || 0;
    if (skini > 0) {
      lager = await pomjeriLager(client, roba_id, objekt_id, skini,
        `Rezanje table — nastao restl ${oznaka}` + (nastao_iz_naloga ? `, nalog ${nastao_iz_naloga}` : ''), user);
      // Pamti se samo ono što je STVARNO skinuto — da storno kasnije vrati tačan iznos
      await client.query('UPDATE restlovi SET lager_umanjeno=$1 WHERE id=$2',
        [lager.primijenjeno ? skini : 0, r.rows[0].id]);
    }

    await client.query('COMMIT');
    res.status(201).json({ ...r.rows[0], lager });
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
    // Kad se iz plana uzima više komada odjednom, uzeta površina je zbir svih —
    // inače bi se sa lagera skinuo samo jedan komad iako je izrezano više.
    const komada = Math.max(1, Math.round(Number(req.body.komada) || 1));

    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM restlovi WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restl nije pronađen.' }); }
    const r = cur.rows[0];
    if (r.status === 'potrosen') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Restl je već označen kao potrošen.' }); }
    if (r.provjeren === 'odbijen') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Restl je odbijen pri provjeri — ne može se koristiti.' }); }

    let noviId = null;
    if (ostatak && ostatak.dim_a && ostatak.dim_b && !potrosen_do_kraja) {
      const ob = ['L', 'poligon'].includes(ostatak.oblik) ? ostatak.oblik : 'pravougaonik';
      let tj;
      if (ob === 'poligon') {
        tj = Array.isArray(ostatak.poligon) ? ostatak.poligon.map(p => [Number(p[0]), Number(p[1])]) : null;
        const g = geo.provjeriTjemena(tj || []);
        if (g) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Ostatak: ' + g }); }
      } else {
        tj = geo.tjemenaOdMjera(ob, ostatak.dim_a, ostatak.dim_b, ostatak.dim_c, ostatak.dim_d);
      }
      const ok2 = geo.okvir(tj);
      const oA = ob === 'poligon' ? ok2.sirina : ostatak.dim_a;
      const oB = ob === 'poligon' ? ok2.visina : ostatak.dim_b;
      const pov = geo.povrsinaPoligona(tj) / 1000000;
      const klasaD = await odrediKlasu(pov);
      const oznaka = await sljedecaOznaka(client);
      const ins = await client.query(
        `INSERT INTO restlovi
           (oznaka, objekt_id, roba_id, materijal, grupa, debljina_cm, oblik,
            dim_a, dim_b, dim_c, dim_d, poligon, povrsina, cijena_m2, foto_url,
            roditelj_id, nastao_iz_naloga, izvor, lokacija, napomena, kreirao_id, kreirao_ime,
            klasa, stanje_komada, mane)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'restl',$18,$19,$20,$21,
                 $22,$23,$24::jsonb)
         RETURNING id, oznaka`,
        [oznaka, r.objekt_id, r.roba_id, r.materijal, r.grupa, r.debljina_cm, ob,
         oA, oB, ostatak.dim_c || 0, ostatak.dim_d || 0, JSON.stringify(tj),
         pov, r.cijena_m2, ostatak.foto_url || null, r.id, nalog_r_br || null,
         ostatak.lokacija || r.lokacija, ostatak.napomena || null, user.id, user.ime_prezime,
         klasaD,
         ['ispravan','sa_manom','za_sitno'].includes(ostatak.stanje_komada) ? ostatak.stanje_komada : 'ispravan',
         Array.isArray(ostatak.mane) && ostatak.mane.length ? JSON.stringify(ostatak.mane) : null]
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

    const uzetoPov = (Number(uzeto_a) || 0) * (Number(uzeto_b) || 0) * komada / 1000000;

    // Sa lagera odlazi SVE što je prestalo da bude zaliha: isječeni komad + otpad.
    // To je tačno (površina roditelja − površina ostatka), pa se otpad ne mora unositi
    // posebno — sam ispadne iz razlike.
    let ostatakPov = 0;
    if (noviId) {
      const np = await client.query('SELECT povrsina FROM restlovi WHERE id=$1', [noviId]);
      ostatakPov = Number(np.rows[0].povrsina) || 0;
    }
    const skinuto = Math.max(0, Number(r.povrsina) - ostatakPov);
    const otpad = Math.max(0, skinuto - uzetoPov);

    const lager = await pomjeriLager(client, r.roba_id, r.objekt_id, skinuto,
      `Restl ${r.oznaka} uzet za nalog ${nalog_r_br || '(bez naloga)'}`, user);

    await client.query(
      `INSERT INTO restl_koristenje
         (restl_id, nalog_r_br, uzeto_a, uzeto_b, uzeto_povrsina, otpad_povrsina,
          lager_umanjeno, novi_restl_id, potrosen_do_kraja, korisnik_id, korisnik_ime, napomena)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [r.id, nalog_r_br || null, uzeto_a || null, uzeto_b || null, uzetoPov, otpad,
       lager.primijenjeno ? skinuto : 0, noviId, !!potrosen_do_kraja || !noviId,
       user.id, user.ime_prezime,
       [napomena, komada > 1 ? komada + ' kom' : null].filter(Boolean).join(' · ') || null]
    );

    await client.query('COMMIT');
    res.json({ ok: true, novi_restl_id: noviId, komada, lager });
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
const IZMJENJIVE = ['materijal', 'grupa', 'debljina_cm', 'oblik', 'dxf_url', 'poligon', 'dim_a', 'dim_b', 'dim_c', 'dim_d',
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
    const pov = geo.povrsinaPoligona(tjemenaRestla(nov)) / 1000000;
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


// POST /api/restlovi/koristenje/:korId/storno — poništava jedno korišćenje:
// roditelj se vraća u 'dostupan', dijete-restl se STORNIRA (ne briše se — ostaje trag),
// a m2 se vraćaju na lager. Ništa se ne briše, po obrascu iz ostatka aplikacije.
router.post('/koristenje/:korId/storno', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const kr = await client.query('SELECT * FROM restl_koristenje WHERE id=$1 FOR UPDATE', [req.params.korId]);
    if (!kr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Korišćenje nije pronađeno.' }); }
    const k = kr.rows[0];
    if (k.stornirano) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Već je stornirano.' }); }

    // Dijete-restl smije da se stornira SAMO ako ni on sam nije već potrošen —
    // inače bismo razvalili lanac koji je nastao poslije njega.
    if (k.novi_restl_id) {
      const d = await client.query('SELECT status, oznaka FROM restlovi WHERE id=$1', [k.novi_restl_id]);
      if (d.rows.length && d.rows[0].status === 'potrosen') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Ne može: restl ${d.rows[0].oznaka} koji je nastao iz ovog je već potrošen. Prvo storniraj njega.`
        });
      }
      await client.query(
        `UPDATE restlovi SET status='potrosen', napomena=COALESCE(napomena,'') || ' [stornirano]',
                potrosio_id=$1, potrosio_ime=$2, potroseno=now() WHERE id=$3`,
        [user.id, user.ime_prezime, k.novi_restl_id]
      );
      await upisiLog(client, k.novi_restl_id, 'status', 'dostupan', 'potrosen (storno)', user);
    }

    const rod = await client.query('SELECT * FROM restlovi WHERE id=$1 FOR UPDATE', [k.restl_id]);
    await client.query(
      `UPDATE restlovi SET status='dostupan', potrosio_id=NULL, potrosio_ime=NULL, potroseno=NULL
        WHERE id=$1`, [k.restl_id]
    );
    await upisiLog(client, k.restl_id, 'status', 'potrosen', 'dostupan (storno)', user);

    // Vraćanje na lager — negativan iznos znači ULAZ
    let lager = null;
    if (Number(k.lager_umanjeno) > 0 && rod.rows.length) {
      lager = await pomjeriLager(client, rod.rows[0].roba_id, rod.rows[0].objekt_id,
        -Number(k.lager_umanjeno), `Storno korišćenja restla ${rod.rows[0].oznaka}`, user);
    }

    await client.query(
      `UPDATE restl_koristenje SET stornirano=true, stornirao_id=$1, stornirao_ime=$2,
              stornirano_kada=now() WHERE id=$3`,
      [user.id, user.ime_prezime, req.params.korId]
    );

    await client.query('COMMIT');
    res.json({ ok: true, lager });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});


/* ─────────────────────────── DXF ─────────────────────────── */

// Minimalni DXF (R12) — samo LINE entiteti i jedan TEXT sa oznakom. Namjerno bez
// LWPOLYLINE jer je stariji CAM softver ne čita uvijek; LINE razumije baš svaki.
function napraviDXF(r) {
  const t = tjemenaRestla(r);
  const red = [];
  const p = (kod, v) => { red.push(String(kod), String(v)); };

  p(0,'SECTION'); p(2,'HEADER');
  p(9,'$INSUNITS'); p(70,4);        // 4 = milimetri
  p(9,'$EXTMIN'); p(10,0); p(20,0); p(30,0);
  p(9,'$EXTMAX'); p(10,r.dim_a); p(20,r.dim_b); p(30,0);
  p(0,'ENDSEC');

  p(0,'SECTION'); p(2,'ENTITIES');
  for (let i = 0; i < t.length; i++) {
    const a = t[i], b = t[(i + 1) % t.length];
    p(0,'LINE'); p(8,'RESTL');
    p(10,a[0]); p(20,a[1]); p(30,0);
    p(11,b[0]); p(21,b[1]); p(31,0);
  }
  // Oznaka i materijal kao tekst unutar komada — da se zna šta je kad se otvori u CAD-u
  p(0,'TEXT'); p(8,'OPIS');
  p(10, Math.round(Number(r.dim_a) * 0.06)); p(20, Math.round(Number(r.dim_b) * 0.06)); p(30,0);
  p(40, Math.max(20, Math.round(Number(r.dim_b) / 20)));
  p(1, `${r.oznaka} ${r.materijal || ''} ${r.debljina_cm ? r.debljina_cm + 'cm' : ''}`.trim());
  p(0,'ENDSEC');

  p(0,'EOF');
  return red.join('\r\n') + '\r\n';
}

// GET /api/restlovi/:id/dxf — preuzimanje crteža restla
router.get('/:id/dxf', smijeVidjeti, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM restlovi WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Restl nije pronađen.' });
    const restl = r.rows[0];
    res.setHeader('Content-Type', 'application/dxf');
    res.setHeader('Content-Disposition', `attachment; filename="${restl.oznaka}.dxf"`);
    res.send(napraviDXF(restl));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/restlovi/:id/dxf-sacuvaj — isti crtež, ali se trajno smjesti na R2 i
// link se zapamti, da se može poslati majstoru bez ponovnog generisanja.
router.post('/:id/dxf-sacuvaj', smijeUnositi, async (req, res) => {
  try {
    const { uploadFile } = require('./storage');
    const r = await pool.query('SELECT * FROM restlovi WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Restl nije pronađen.' });
    const restl = r.rows[0];
    const buf = Buffer.from(napraviDXF(restl), 'utf8');
    const link = await uploadFile(`restlovi/${restl.oznaka}.dxf`, buf, 'application/dxf');
    await pool.query('UPDATE restlovi SET dxf_url=$1 WHERE id=$2', [link, restl.id]);
    res.json({ ok: true, link });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
        WHERE k.nalog_r_br = $1 AND k.stornirano = false ORDER BY k.kada`,
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


/* ─────────────────── VERIFIKACIJA POVRATA RESTLA ───────────────────
   Restl nastao rezanjem ODMAH ulazi u opticaj — može se uzeti u drugi nalog bez
   čekanja. Provjera je naknadna i služi da se uhvati pogrešno upisana mjera ili
   komad kojeg fizički nema. Zato se ne blokira rad, nego se greška ispravlja kad
   se otkrije. */

// nalog_materijal.nalog_r_br je INTEGER u bazi, pa se broj naloga mora pretvoriti.
// Ako nije broj, upis se odbija odmah umjesto da pukne u bazi.
function brojNaloga(v) {
  const n = parseInt(String(v ?? '').trim(), 10);
  if (!isFinite(n)) throw new Error('Broj naloga mora biti cijeli broj: ' + v);
  return n;
}

function smijeOdobriti(user) {
  return !!(user && (user.rola === 'admin' || user.moze_ugovarati));
}

// GET /api/restlovi/za-provjeru
router.get('/za-provjeru', smijeVidjeti, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.id, r.oznaka, r.materijal, r.dim_a, r.dim_b, r.povrsina, r.poligon, r.oblik,
              r.kreirao_ime, r.kreirano, r.nastao_iz_naloga, r.foto_url, r.lokacija,
              po.naziv AS objekt_naziv, ro.naziv AS artikal_naziv, ro.sifra AS artikal_sifra,
              rod.oznaka AS roditelj_oznaka
         FROM restlovi r
         LEFT JOIN prodajni_objekti po ON po.id = r.objekt_id
         LEFT JOIN roba ro ON ro.id = r.roba_id
         LEFT JOIN restlovi rod ON rod.id = r.roditelj_id
        WHERE r.provjeren = 'ceka' AND r.status <> 'potrosen'
        ORDER BY r.kreirano DESC LIMIT 200`);
    res.json({ stavke: r.rows, smijem: smijeOdobriti(req.session?.user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/restlovi/:id/provjeri
// body: { odluka: 'potvrdjen' | 'odbijen', dim_a?, dim_b?, poligon?, napomena? }
router.post('/:id/provjeri', async (req, res) => {
  const user = req.session?.user;
  if (!smijeOdobriti(user)) return res.status(403).json({ error: 'Provjeru odobrava onaj ko ima pravo ugovaranja.' });

  const client = await pool.connect();
  try {
    const { odluka, dim_a, dim_b, poligon, napomena } = req.body;
    if (!['potvrdjen', 'odbijen'].includes(odluka))
      return res.status(400).json({ error: 'Odluka mora biti "potvrdjen" ili "odbijen".' });
    // Odbijanje traži razlog — inače se kasnije ne zna šta je bilo prijavljeno
    if (odluka === 'odbijen' && !String(napomena || '').trim())
      return res.status(400).json({ error: 'Za odbijanje je obavezan razlog.' });

    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM restlovi WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restl nije pronađen.' }); }
    const r = cur.rows[0];
    if (r.provjeren !== 'ceka') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Restl je već provjeren.' }); }

    if (odluka === 'odbijen') {
      // Ne briše se — ostaje trag šta je bilo prijavljeno i zašto nije prošlo
      await client.query(
        `UPDATE restlovi SET provjeren='odbijen', status='greska', provjerio_id=$1,
                provjerio_ime=$2, provjereno=now(), provjera_napomena=$3 WHERE id=$4`,
        [user.id, user.ime_prezime, String(napomena).trim(), r.id]);
      await upisiLog(client, r.id, 'provjeren', 'ceka', 'odbijen: ' + String(napomena).trim(), user);
      await client.query('COMMIT');
      return res.json({ ok: true, odluka: 'odbijen' });
    }

    // Potvrda, uz moguću ispravku mjera
    let ispravljeno = false;
    const noviA = Number(dim_a) || 0, noviB = Number(dim_b) || 0;
    const jePoligon = Array.isArray(poligon) && poligon.length >= 3;

    if (jePoligon || (noviA && noviB && (noviA !== Number(r.dim_a) || noviB !== Number(r.dim_b)))) {
      let tjemena;
      if (jePoligon) {
        const g = geo.provjeriTjemena(poligon);
        if (g) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Oblik: ' + g }); }
        tjemena = poligon;
      } else {
        tjemena = [[0,0],[noviA,0],[noviA,noviB],[0,noviB]];
      }
      const okv = geo.okvir(tjemena);
      const pov = geo.povrsinaPoligona(tjemena) / 1e6;
      // Stare mjere se PAMTE — da se vidi šta je operater upisao a šta je provjera zatekla
      await client.query(
        `UPDATE restlovi SET dim_a=$1, dim_b=$2, poligon=$3::jsonb, povrsina=$4,
                mjere_prije=$5::jsonb WHERE id=$6`,
        [Math.round(okv.sirina), Math.round(okv.visina), JSON.stringify(tjemena), pov,
         JSON.stringify({ dim_a: r.dim_a, dim_b: r.dim_b, povrsina: r.povrsina, poligon: r.poligon }),
         r.id]);
      await upisiLog(client, r.id, 'mjere', r.dim_a + '×' + r.dim_b,
        Math.round(okv.sirina) + '×' + Math.round(okv.visina) + ' (provjera)', user);
      ispravljeno = true;
    }

    await client.query(
      `UPDATE restlovi SET provjeren='potvrdjen', provjerio_id=$1, provjerio_ime=$2,
              provjereno=now(), provjera_napomena=$3 WHERE id=$4`,
      [user.id, user.ime_prezime, napomena || null, r.id]);
    await upisiLog(client, r.id, 'provjeren', 'ceka', 'potvrdjen', user);
    await client.query('COMMIT');
    res.json({ ok: true, odluka: 'potvrdjen', mjere_ispravljene: ispravljeno });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* ─────────────────── MATERIJAL NALOGA: VIŠE IZVORA ───────────────────
   Jedan nalog rijetko stane u jedan restl — obično ide nekoliko restlova pa ostatak
   iz cijele table. Svaki izvor je zaseban red, pa se vidi odakle je šta došlo. */

// GET /api/restlovi/nalog/:r_br/materijal
router.get('/nalog/:r_br/materijal', smijeVidjeti, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT nm.*, r.oznaka AS restl_oznaka, r.materijal AS restl_materijal,
              ro.naziv AS artikal_naziv, ro.sifra AS artikal_sifra,
              po.naziv AS objekt_naziv
         FROM nalog_materijal nm
         LEFT JOIN restlovi r ON r.id = nm.restl_id
         LEFT JOIN roba ro ON ro.id = nm.roba_id
         LEFT JOIN prodajni_objekti po ON po.id = nm.objekt_id
        WHERE nm.nalog_r_br = $1 AND nm.stornirano = false
        ORDER BY nm.uzeto`, [brojNaloga(req.params.r_br)]);
    const s = r.rows;
    res.json({
      stavke: s,
      ukupno_m2: Math.round(s.reduce((z, x) => z + (Number(x.povrsina) || 0), 0) * 10000) / 10000,
      restlova: s.filter(x => x.vrsta === 'restl').length,
      tabli: s.filter(x => x.vrsta === 'tabla').length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/restlovi/nalog/:r_br/uzmi
router.post('/nalog/:r_br/uzmi', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    const { vrsta, restl_id, roba_id, povrsina, dim_a, dim_b, napomena } = req.body;
    const pozicijaId = req.body.pozicija_id || null;
    const pozicijaNaziv = req.body.pozicija_naziv || null;
    const komadaStavke = Math.max(1, Math.round(Number(req.body.komada) || 1));
    if (!['restl', 'tabla'].includes(vrsta))
      return res.status(400).json({ error: 'Vrsta mora biti "restl" ili "tabla".' });

    await client.query('BEGIN');
    let red;

    if (vrsta === 'restl') {
      if (!restl_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nedostaje restl.' }); }
      // FOR UPDATE — dva operatera u istom trenutku ne mogu uzeti isti komad
      const cur = await client.query('SELECT * FROM restlovi WHERE id=$1 FOR UPDATE', [restl_id]);
      if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restl nije pronađen.' }); }
      const r = cur.rows[0];
      if (r.status === 'potrosen') { await client.query('ROLLBACK'); return res.status(400).json({ error: `Restl ${r.oznaka} je već potrošen.` }); }
      if (r.provjeren === 'odbijen') { await client.query('ROLLBACK'); return res.status(400).json({ error: `Restl ${r.oznaka} je odbijen pri provjeri — ne može se koristiti.` }); }

      await client.query(
        `UPDATE restlovi SET status='rezervisan', nastao_iz_naloga=COALESCE(nastao_iz_naloga,$1) WHERE id=$2`,
        [brojNaloga(req.params.r_br), r.id]);
      red = await client.query(
        `INSERT INTO nalog_materijal (nalog_r_br, vrsta, restl_id, roba_id, objekt_id,
            povrsina, dim_a, dim_b, napomena, uzeo_id, uzeo_ime)
         VALUES ($1,'restl',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [brojNaloga(req.params.r_br), r.id, r.roba_id, r.objekt_id, r.povrsina,
         r.dim_a, r.dim_b, napomena || null, user.id, user.ime_prezime]);
      await upisiLog(client, r.id, 'status', r.status, 'rezervisan za nalog ' + req.params.r_br, user);
    } else {
      if (!roba_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nedostaje artikal za cijelu tablu.' }); }

      // Provjera stanja na lageru prije trebovanja — bolje reći odmah da nema,
      // nego dopustiti trebovanje pa da se u magacinu ispostavi da table nema.
      const lagerRed = await client.query(
        `SELECT rp.stanje, ro.naziv, ro.jed_mjera, ro.sifra
           FROM roba ro LEFT JOIN roba_pj rp ON rp.roba_id = ro.id AND rp.objekt_id = $2
          WHERE ro.id = $1`, [roba_id, req.body.objekt_id || null]);
      if (!lagerRed.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Artikal nije pronađen u lager listi.' }); }
      const art = lagerRed.rows[0];
      const trazenoM2 = Number(povrsina) || 0;

      red = await client.query(
        `INSERT INTO nalog_materijal (nalog_r_br, vrsta, roba_id, objekt_id, povrsina,
            dim_a, dim_b, napomena, uzeo_id, uzeo_ime, pozicija_id, pozicija_naziv, komada)
         VALUES ($1,'tabla',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [brojNaloga(req.params.r_br), roba_id, req.body.objekt_id || null,
         trazenoM2, dim_a || null, dim_b || null,
         napomena || null, user.id, user.ime_prezime,
         pozicijaId, pozicijaNaziv, komadaStavke]);

      // Skidanje sa lagera ide kroz istu funkciju kao i kod restlova — pa poštuje
      // prekidač zaključavanja i upisuje trag u roba_kretanja.
      const lager = await pomjeriLager(client, roba_id, req.body.objekt_id || null, trazenoM2,
        `Cijela tabla trebovana za nalog ${req.params.r_br}`, user);

      await client.query('COMMIT');
      return res.json({
        ok: true, stavka: red.rows[0], lager,
        artikal: { sifra: art.sifra, naziv: art.naziv, jed_mjera: art.jed_mjera },
        stanje_prije: Number(art.stanje) || 0,
        upozorenje: (Number(art.stanje) || 0) < trazenoM2
          ? `Na lageru je ${(Number(art.stanje)||0).toFixed(2)} ${art.jed_mjera || ''}, a trebovano ${trazenoM2.toFixed(2)} — provjeri stanje.`
          : null,
      });
    }

    await client.query('COMMIT');
    res.json({ ok: true, stavka: red.rows[0],
               napomena: 'Lager nije mijenjan — restl se skida tek kad se stvarno isječe.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// DELETE /api/restlovi/nalog-materijal/:id — storno, restl se vraća u opticaj
router.delete('/nalog-materijal/:id', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM nalog_materijal WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Stavka nije pronađena.' }); }
    const s = cur.rows[0];
    if (s.stornirano) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Već je stornirano.' }); }

    // Zapis OSTAJE — samo se označi, da se vidi da je materijal bio uzet pa vraćen
    await client.query(
      `UPDATE nalog_materijal SET stornirano=true, stornirao_ime=$1, stornirano_kada=now() WHERE id=$2`,
      [user.ime_prezime, s.id]);

    if (s.restl_id) {
      const r = await client.query('SELECT status, oznaka FROM restlovi WHERE id=$1', [s.restl_id]);
      // Restl koji je u međuvremenu stvarno isječen se NE vraća — to više nije isti komad
      if (r.rows.length && r.rows[0].status === 'rezervisan') {
        await client.query(`UPDATE restlovi SET status='dostupan' WHERE id=$1`, [s.restl_id]);
        await upisiLog(client, s.restl_id, 'status', 'rezervisan', 'dostupan (storno naloga)', user);
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});


/* DELETE /api/restlovi/nalog/:r_br/vrati-sve — vraća SVE restlove uzete za nalog.
   Potrebno kad se u toku planiranja ispostavi da nema dovoljno materijala: operater
   je već rezervisao nekoliko komada, a nalog se ne može završiti iz restlova. Bez
   ovoga bi ti komadi ostali zaključani za nalog koji nikad neće biti izrezan. */
router.delete('/nalog/:r_br/vrati-sve', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const st = await client.query(
      `SELECT * FROM nalog_materijal
        WHERE nalog_r_br = $1 AND stornirano = false FOR UPDATE`,
      [brojNaloga(req.params.r_br)]);

    if (!st.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, vraceno: 0, poruka: 'Za ovaj nalog nema uzetog materijala.' });
    }

    const vraceni = [], preskoceni = [];
    for (const s of st.rows) {
      if (!s.restl_id) continue;
      const r = await client.query('SELECT status, oznaka FROM restlovi WHERE id=$1 FOR UPDATE', [s.restl_id]);
      if (!r.rows.length) continue;
      // Restl koji je u međuvremenu STVARNO isječen se ne vraća — to više nije
      // isti komad, pa bi ga vraćanje pretvorilo u zalihu koje nema.
      if (r.rows[0].status !== 'rezervisan') { preskoceni.push(r.rows[0].oznaka); continue; }
      await client.query(`UPDATE restlovi SET status='dostupan' WHERE id=$1`, [s.restl_id]);
      await upisiLog(client, s.restl_id, 'status', 'rezervisan',
        'dostupan (nalog ' + req.params.r_br + ' vraćen u cjelini)', user);
      vraceni.push(r.rows[0].oznaka);
    }

    await client.query(
      `UPDATE nalog_materijal SET stornirano=true, stornirao_ime=$1, stornirano_kada=now()
        WHERE nalog_r_br=$2 AND stornirano=false`,
      [user.ime_prezime, brojNaloga(req.params.r_br)]);

    await client.query('COMMIT');
    res.json({
      ok: true,
      vraceno: vraceni.length,
      oznake: vraceni,
      preskoceni,
      poruka: vraceni.length + ' restl(ova) vraćeno u opticaj' +
        (preskoceni.length ? '; ' + preskoceni.length + ' je već isječeno i nije vraćeno' : '') + '.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});


/* ─────────────── STATUS U PROIZVODNJI ───────────────
   Tok restla: dostupan → rezervisan (planiran za nalog) → u_proizvodnji (otišao na
   mašinu) → potrosen (isječen) ili nastane novi restl od ostatka.
   Međustanje postoji da se vidi šta je fizički na mašini, a šta je samo planirano. */

// POST /api/restlovi/:id/u-proizvodnju
router.post('/:id/u-proizvodnju', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM restlovi WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restl nije pronađen.' }); }
    const r = cur.rows[0];
    if (r.status === 'potrosen') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Restl je već potrošen.' }); }
    if (r.status === 'u_proizvodnji') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Restl je već u proizvodnji.' }); }
    if (r.provjeren === 'odbijen') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Restl je odbijen pri provjeri.' }); }

    const nalog = req.body.nalog_r_br || r.nastao_iz_naloga || null;
    await client.query(
      `UPDATE restlovi SET status='u_proizvodnji', u_proizvodnji_od=now(),
              u_proizvodnji_nalog=$1 WHERE id=$2`, [nalog, r.id]);
    await upisiLog(client, r.id, 'status', r.status,
      'u_proizvodnji' + (nalog ? ' (nalog ' + nalog + ')' : ''), user);
    await client.query('COMMIT');
    res.json({ ok: true, status: 'u_proizvodnji' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/restlovi/:id/vrati-sa-masine — komad se vraća neisječen
router.post('/:id/vrati-sa-masine', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM restlovi WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restl nije pronađen.' }); }
    const r = cur.rows[0];
    if (r.status !== 'u_proizvodnji') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Restl nije u proizvodnji, nego u stanju "' + r.status + '".' });
    }
    await client.query(
      `UPDATE restlovi SET status='dostupan', u_proizvodnji_od=NULL, u_proizvodnji_nalog=NULL WHERE id=$1`, [r.id]);
    await upisiLog(client, r.id, 'status', 'u_proizvodnji', 'dostupan (vraćen sa mašine)', user);
    await client.query('COMMIT');
    res.json({ ok: true, status: 'dostupan' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/restlovi/u-proizvodnji — šta je trenutno na mašinama
router.get('/u-proizvodnji', smijeVidjeti, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.*, po.naziv AS objekt_naziv, ro.naziv AS artikal_naziv, ro.sifra AS artikal_sifra,
              EXTRACT(EPOCH FROM (now() - r.u_proizvodnji_od))/3600 AS sati
         FROM restlovi r
         LEFT JOIN prodajni_objekti po ON po.id = r.objekt_id
         LEFT JOIN roba ro ON ro.id = r.roba_id
        WHERE r.status IN ('rezervisan','u_proizvodnji')
        ORDER BY r.status DESC, r.u_proizvodnji_od NULLS LAST`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


/* GET /api/restlovi/nalog/:r_br/bilans
   Poredi ŠTA NALOG TRAŽI sa ONIM ŠTO JE UZETO — po artiklu, jer se granit i kvarc
   ne mogu sabirati. Odgovara na pitanje "je li trebovano dovoljno", koje se iz same
   liste uzetog ne vidi: tamo stoji koliko je uzeto, ali ne i koliko treba.
   body ili query: pozicije se šalju jer nalog nije u ovoj bazi. */
router.post('/nalog/:r_br/bilans', smijeVidjeti, async (req, res) => {
  try {
    const pozicije = Array.isArray(req.body.pozicije) ? req.body.pozicije : [];
    const rezMm = Number(req.body.rez) || 5;

    // 1. Šta nalog traži — po artiklu, uz otpad na rez
    const traziPoArtiklu = new Map();
    for (const p of pozicije) {
      const sir = Number(p.sirina) || 0, vis = Number(p.visina) || 0;
      const kom = Math.max(1, Math.round(Number(p.kolicina) || 1));
      if (!sir || !vis) continue;
      // Sa rezom, jer se toliko materijala stvarno troši
      const pov = ((sir + rezMm) * (vis + rezMm) * kom) / 1e6;
      const kljuc = p.roba_id || ('naziv:' + (p.materijal || 'nepoznato'));
      const t = traziPoArtiklu.get(kljuc) || { roba_id: p.roba_id || null,
        materijal: p.materijal || null, m2: 0, komada: 0, pozicije: [] };
      t.m2 += pov; t.komada += kom;
      t.pozicije.push({ naziv: p.naziv, sirina: sir, visina: vis, kolicina: kom });
      traziPoArtiklu.set(kljuc, t);
    }

    // 2. Šta je uzeto — iz nalog_materijal
    const uzeto = await pool.query(
      `SELECT nm.vrsta, nm.roba_id, nm.povrsina, nm.restl_id,
              ro.naziv AS artikal_naziv, ro.sifra
         FROM nalog_materijal nm
         LEFT JOIN roba ro ON ro.id = nm.roba_id
        WHERE nm.nalog_r_br = $1 AND nm.stornirano = false`,
      [brojNaloga(req.params.r_br)]);

    const uzetoPoArtiklu = new Map();
    for (const u of uzeto.rows) {
      const kljuc = u.roba_id || ('naziv:' + (u.artikal_naziv || 'nepoznato'));
      const t = uzetoPoArtiklu.get(kljuc) || { roba_id: u.roba_id, artikal_naziv: u.artikal_naziv,
        sifra: u.sifra, restlovi_m2: 0, table_m2: 0, restlova: 0, tabli: 0 };
      if (u.vrsta === 'restl') { t.restlovi_m2 += Number(u.povrsina) || 0; t.restlova++; }
      else { t.table_m2 += Number(u.povrsina) || 0; t.tabli++; }
      uzetoPoArtiklu.set(kljuc, t);
    }

    // 3. Bilans — po svakom artiklu koji se pojavljuje na bilo kojoj strani
    const svi = new Set([...traziPoArtiklu.keys(), ...uzetoPoArtiklu.keys()]);
    const stavke = [];
    for (const k of svi) {
      const t = traziPoArtiklu.get(k) || { m2: 0, komada: 0, pozicije: [], roba_id: null, materijal: null };
      const u = uzetoPoArtiklu.get(k) || { restlovi_m2: 0, table_m2: 0, restlova: 0, tabli: 0 };
      const uzetoUkupno = u.restlovi_m2 + u.table_m2;
      const razlika = uzetoUkupno - t.m2;
      stavke.push({
        roba_id: t.roba_id || u.roba_id || null,
        artikal: u.artikal_naziv || t.materijal || '(nepoznat artikal)',
        sifra: u.sifra || null,
        treba_m2: Math.round(t.m2 * 10000) / 10000,
        treba_komada: t.komada,
        uzeto_m2: Math.round(uzetoUkupno * 10000) / 10000,
        iz_restlova_m2: Math.round(u.restlovi_m2 * 10000) / 10000,
        iz_tabli_m2: Math.round(u.table_m2 * 10000) / 10000,
        restlova: u.restlova, tabli: u.tabli,
        razlika_m2: Math.round(razlika * 10000) / 10000,
        // Namjerno bez tolerancije nadolje: ako fali makar malo, mora se vidjeti
        stanje: razlika >= -0.0001 ? (razlika > t.m2 * 0.25 ? 'visak' : 'dovoljno') : 'fali',
        pozicije: t.pozicije,
      });
    }
    stavke.sort((a, b) => (a.stanje === 'fali' ? -1 : 1) - (b.stanje === 'fali' ? -1 : 1));

    res.json({
      stavke,
      sazetak: {
        treba_m2: Math.round(stavke.reduce((z, x) => z + x.treba_m2, 0) * 10000) / 10000,
        uzeto_m2: Math.round(stavke.reduce((z, x) => z + x.uzeto_m2, 0) * 10000) / 10000,
        artikala_fali: stavke.filter(x => x.stanje === 'fali').length,
        artikala_visak: stavke.filter(x => x.stanje === 'visak').length,
        pokriveno: stavke.length > 0 && stavke.every(x => x.stanje !== 'fali'),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


/* POST /api/restlovi/nalozi/stanje
   Stanje materijala za VIŠE naloga odjednom — da lista naloga ne zove rutu po redu.
   Vraća šta je uzeto i, ako se pošalje potrebna kvadratura, da li je nalog pokriven.

   body: { nalozi: [372, 373, 374], potrebno: { "372": 6.2, "373": 3.1 } }
   Polje `potrebno` je opciono — bez njega se vraća samo uzeto, jer restlovi ne znaju
   šta nalog traži; te podatke ima lista naloga. */
router.post('/nalozi/stanje', smijeVidjeti, async (req, res) => {
  try {
    const nalozi = (Array.isArray(req.body.nalozi) ? req.body.nalozi : [])
      .map(x => parseInt(String(x).trim(), 10)).filter(Number.isFinite);
    if (!nalozi.length) return res.json({ nalozi: {} });
    const potrebno = req.body.potrebno || {};

    const r = await pool.query(
      `SELECT nm.nalog_r_br, nm.vrsta,
              COUNT(*)::int AS koliko,
              COALESCE(SUM(nm.povrsina), 0) AS m2,
              MAX(nm.uzeto) AS zadnje
         FROM nalog_materijal nm
        WHERE nm.nalog_r_br = ANY($1::int[]) AND nm.stornirano = false
        GROUP BY nm.nalog_r_br, nm.vrsta`, [nalozi]);

    // Koliko je restlova za taj nalog još u proizvodnji — nalog nije gotov dok su na mašini
    const uProizvodnji = await pool.query(
      `SELECT nm.nalog_r_br, COUNT(*)::int AS koliko
         FROM nalog_materijal nm
         JOIN restlovi rs ON rs.id = nm.restl_id
        WHERE nm.nalog_r_br = ANY($1::int[]) AND nm.stornirano = false
          AND rs.status IN ('rezervisan','u_proizvodnji')
        GROUP BY nm.nalog_r_br`, [nalozi]);
    const naMasini = new Map(uProizvodnji.rows.map(x => [Number(x.nalog_r_br), x.koliko]));

    const izlaz = {};
    for (const n of nalozi) {
      izlaz[n] = { restlova: 0, tabli: 0, restlovi_m2: 0, table_m2: 0, uzeto_m2: 0,
                   na_masini: naMasini.get(n) || 0, zadnje: null,
                   treba_m2: null, pokriven: null, fali_m2: null, stanje: 'nista' };
    }
    for (const x of r.rows) {
      const n = izlaz[Number(x.nalog_r_br)];
      if (!n) continue;
      const m2 = Number(x.m2) || 0;
      if (x.vrsta === 'restl') { n.restlova = x.koliko; n.restlovi_m2 = m2; }
      else { n.tabli = x.koliko; n.table_m2 = m2; }
      n.uzeto_m2 = Math.round((n.restlovi_m2 + n.table_m2) * 10000) / 10000;
      if (!n.zadnje || x.zadnje > n.zadnje) n.zadnje = x.zadnje;
    }

    for (const n of nalozi) {
      const t = potrebno[n] != null ? Number(potrebno[n]) : null;
      const z = izlaz[n];
      if (t != null && isFinite(t) && t > 0) {
        z.treba_m2 = Math.round(t * 10000) / 10000;
        z.fali_m2 = Math.round(Math.max(0, t - z.uzeto_m2) * 10000) / 10000;
        z.pokriven = z.uzeto_m2 >= t - 0.0001;
      }
      // Jedno stanje koje lista može prikazati kao znak, bez daljeg računanja
      z.stanje = z.uzeto_m2 === 0 ? 'nista'
        : (z.pokriven === false ? 'djelimicno'
        : (z.na_masini ? 'u_radu' : 'pokriven'));
    }

    res.json({ nalozi: izlaz });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


/* POST /api/restlovi/nalozi/pozicije-stanje
   Broji ZAVRŠENE POZICIJE, ne kvadraturu — "3 od 5 završeno" je ono što se vidi u
   listi naloga. Pozicija je završena kad je materijal za nju stvarno isječen, ne kad
   je samo rezervisan.

   body: { nalozi: [372, 373], pozicije: { "372": [{id, naziv, kolicina}, …] } }
   Spisak pozicija šalje lista naloga — restlovi ga nemaju. */
router.post('/nalozi/pozicije-stanje', smijeVidjeti, async (req, res) => {
  try {
    const nalozi = (Array.isArray(req.body.nalozi) ? req.body.nalozi : [])
      .map(x => parseInt(String(x).trim(), 10)).filter(Number.isFinite);
    if (!nalozi.length) return res.json({ nalozi: {} });
    const pozicijePoNalogu = req.body.pozicije || {};

    const r = await pool.query(
      `SELECT nm.nalog_r_br, nm.pozicija_id, nm.pozicija_naziv, nm.komada,
              nm.zavrseno, nm.vrsta, nm.restl_id, rs.status AS restl_status
         FROM nalog_materijal nm
         LEFT JOIN restlovi rs ON rs.id = nm.restl_id
        WHERE nm.nalog_r_br = ANY($1::int[]) AND nm.stornirano = false`, [nalozi]);

    const izlaz = {};
    for (const n of nalozi) {
      const zadate = Array.isArray(pozicijePoNalogu[n]) ? pozicijePoNalogu[n] : [];
      const stavke = r.rows.filter(x => Number(x.nalog_r_br) === n);

      // Po poziciji: koliko je komada planirano i koliko stvarno isječeno
      const poPoziciji = new Map();
      for (const z of zadate) {
        poPoziciji.set(String(z.id), {
          id: z.id, naziv: z.naziv || '',
          treba: Math.max(1, Math.round(Number(z.kolicina) || 1)),
          planirano: 0, zavrseno: 0, u_radu: 0,
        });
      }
      for (const x of stavke) {
        const k = String(x.pozicija_id ?? '');
        // Stavka bez veze na poziciju (stariji zapisi) se vodi zasebno
        if (!poPoziciji.has(k)) {
          poPoziciji.set(k, { id: x.pozicija_id || null, naziv: x.pozicija_naziv || '(bez pozicije)',
            treba: 0, planirano: 0, zavrseno: 0, u_radu: 0 });
        }
        const p = poPoziciji.get(k);
        const kom = Math.max(1, Number(x.komada) || 1);
        p.planirano += kom;
        if (x.zavrseno || (x.vrsta === 'restl' && x.restl_status === 'potrosen')) p.zavrseno += kom;
        else if (x.restl_status === 'u_proizvodnji' || x.restl_status === 'rezervisan') p.u_radu += kom;
      }

      const lista = [...poPoziciji.values()].map(p => ({
        ...p,
        // Pozicija je gotova kad je isječeno bar onoliko komada koliko traži
        gotova: p.treba > 0 ? p.zavrseno >= p.treba : (p.planirano > 0 && p.zavrseno >= p.planirano),
      }));
      const ukupno = zadate.length || lista.length;
      const gotovih = lista.filter(p => p.gotova).length;
      const zapoceto = lista.some(p => p.planirano > 0);

      izlaz[n] = {
        ukupno, gotovih, nezavrsenih: Math.max(0, ukupno - gotovih),
        pozicije: lista,
        zapoceto,
        // Prijedlog statusa za listu naloga:
        //   nije_zapoceto → ništa nije uzeto
        //   u_radu        → počelo, ali nisu sve pozicije gotove
        //   ceka_isporuku → sve pozicije završene
        predlozeni_status: !zapoceto ? 'nije_zapoceto'
          : (ukupno > 0 && gotovih >= ukupno ? 'ceka_isporuku' : 'u_radu'),
      };
    }

    res.json({ nalozi: izlaz });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


/* POST /api/restlovi/:id/mane — opis mane na postojećem komadu.
   Mana koja NE mijenja oblik (ogrebotina, mrlja, ton) samo se bilježi. Mana koja
   smanjuje upotrebljivost (rupa, odlomljen ugao) unosi se kao umanjena korisna
   površina — komad se vodi kao manji nego što jeste, uz napomenu zašto. */
router.post('/:id/mane', smijeUnositi, async (req, res) => {
  const user = req.session.user;
  const client = await pool.connect();
  try {
    const { mane, stanje_komada, korisna_povrsina } = req.body;
    if (stanje_komada && !['ispravan','sa_manom','za_sitno'].includes(stanje_komada))
      return res.status(400).json({ error: 'Nepoznato stanje komada.' });

    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM restlovi WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restl nije pronađen.' }); }
    const r = cur.rows[0];

    const kor = Number(korisna_povrsina) || null;
    if (kor && kor > Number(r.povrsina) + 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Korisna površina ne može biti veća od stvarne (' +
        Number(r.povrsina).toFixed(3) + ' m²).' });
    }

    await client.query(
      `UPDATE restlovi SET mane=$1::jsonb, stanje_komada=COALESCE($2, stanje_komada),
              korisna_povrsina=$3 WHERE id=$4`,
      [Array.isArray(mane) && mane.length ? JSON.stringify(mane) : null,
       stanje_komada || null, kor, r.id]);

    if (stanje_komada && stanje_komada !== r.stanje_komada)
      await upisiLog(client, r.id, 'stanje_komada', r.stanje_komada, stanje_komada, user);
    if (kor && kor !== Number(r.korisna_povrsina))
      await upisiLog(client, r.id, 'korisna_povrsina', r.korisna_povrsina, kor, user);

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});


module.exports = router;
