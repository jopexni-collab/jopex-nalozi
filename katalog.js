// routes/katalog.js
// ══ KATALOG ZA SLANJE KUPCU ═══════════════════════════════════════════════════════
// Zaposleni (blagajnik / komercijalista / teren) sastavi katalog i posalje link kupcu.
// Cijene se racunaju prema VRSTI KUPCA (tipovi_kupaca) — ista pravila kao svuda, preko
// zajednickog modula cijene.js, da se formula ne prepisuje na dva mjesta.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('./db');
const { izracunajCijenu, pdvStopa } = require('./cijene');

// Svako ko radi sa kupcima moze slati katalog — blagajnik, prodaja, teren, ugovaranje.
// Namjerno siroko: "svako u firmi moze doci u situaciji da nesto proda".
function smijeSlati(req, res, next) {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati || u?.komercijalista_teren ||
      u?.moze_ugovarati || u?.moze_roba_magacin) return next();
  const jeBlagajnik = u?.id != null;
  if (jeBlagajnik) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za slanje kataloga.' });
}

// GET /api/katalog/grupe?objekt_id=X — koje grupe proizvoda uopste postoje u tom lageru
// GET /api/katalog/gradovi?tip_id=X — gradovi u kojima ima kupaca tog tipa
// (npr. izabereš "Proizvođač kuhinja" pa vidiš da ih u Gradišci ima 7)
router.get('/gradovi', smijeSlati, async (req, res) => {
  try {
    const tipId = req.query.tip_id ? parseInt(req.query.tip_id) : null;
    const uslovTipa = tipId
      ? 'AND EXISTS (SELECT 1 FROM kupac_tipovi kt WHERE kt.kupac_id = k.id AND kt.tip_id = $1)'
      : '';
    const r = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(k.grad),''), '(bez grada)') AS grad, COUNT(*) AS broj
       FROM kupci k
       WHERE k.aktivan = true ${uslovTipa}
       GROUP BY 1 ORDER BY COUNT(*) DESC, 1`,
      tipId ? [tipId] : []
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/katalog/primaoci?tip_id=X&grad=Y — kupci kojima se šalje katalog
router.get('/primaoci', smijeSlati, async (req, res) => {
  try {
    const tipId = req.query.tip_id ? parseInt(req.query.tip_id) : null;
    const grad = (req.query.grad || '').trim();
    const uslovi = ['k.aktivan = true'];
    const vals = [];
    if (tipId) {
      vals.push(tipId);
      uslovi.push(`EXISTS (SELECT 1 FROM kupac_tipovi kt WHERE kt.kupac_id = k.id AND kt.tip_id = $${vals.length})`);
    }
    if (grad && grad !== '(bez grada)') {
      vals.push(grad);
      uslovi.push(`TRIM(k.grad) ILIKE $${vals.length}`);
    } else if (grad === '(bez grada)') {
      uslovi.push(`(k.grad IS NULL OR TRIM(k.grad) = '')`);
    }
    const r = await pool.query(
      `SELECT k.id, k.naziv, k.telefon, k.email, k.grad
       FROM kupci k WHERE ${uslovi.join(' AND ')} ORDER BY k.naziv`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/katalog/debljine?grupe=a,b — koje debljine postoje u izabranim grupama
router.get('/debljine', smijeSlati, async (req, res) => {
  try {
    const grupe = (req.query.grupe || '').split(',').map(s=>s.trim()).filter(Boolean);
    if (!grupe.length) return res.json([]);
    const r = await pool.query(
      `SELECT r.debljina_cm, COUNT(*) AS broj FROM roba r
       WHERE r.aktivan = true AND r.grupa = ANY($1) AND r.debljina_cm IS NOT NULL
       GROUP BY r.debljina_cm ORDER BY r.debljina_cm`, [grupe]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/grupe', smijeSlati, async (req, res) => {
  try {
    const objektId = parseInt(req.query.objekt_id);
    // Pretraga hvata i NAZIV/SIFRU artikla, ne samo naziv grupe — pa se ukucavanjem
    // "bengal" ili "8373" pronadje grupa u kojoj taj artikal jeste.
    const q = (req.query.q || '').trim();
    // Uz svaku grupu ide i MASTER grupa (granit, kvarc...) — da se u katalogu moze
    // birati po master grupi, pa se npr. granit ne salje vlasnicima salona namjestaja.
    const vals = [];
    let objektDio = '';
    if (objektId) { vals.push(objektId); objektDio = `AND rp.objekt_id = $${vals.length}`; }
    let uslovPretrage = '';
    if (q) {
      vals.push(`%${q}%`);
      uslovPretrage = `AND (r.grupa ILIKE $${vals.length} OR r.naziv ILIKE $${vals.length} OR r.sifra ILIKE $${vals.length}
                            OR EXISTS (SELECT 1 FROM master_grupe m2
                                       WHERE m2.id = COALESCE(r.master_grupa_id, gm.master_grupa_id)
                                         AND m2.naziv ILIKE $${vals.length}))`;
    }
    const r = await pool.query(
      `SELECT r.grupa, COUNT(*) AS broj,
              COALESCE(r.master_grupa_id, gm.master_grupa_id) AS master_id,
              mg.naziv AS master_naziv
       FROM roba r
       JOIN roba_pj rp ON rp.roba_id = r.id ${objektDio}
       LEFT JOIN grupa_master gm ON gm.grupa = r.grupa
       LEFT JOIN master_grupe mg ON mg.id = COALESCE(r.master_grupa_id, gm.master_grupa_id)
       WHERE r.aktivan = true AND r.grupa IS NOT NULL AND r.grupa <> ''
         ${uslovPretrage}
       GROUP BY r.grupa, COALESCE(r.master_grupa_id, gm.master_grupa_id), mg.naziv
       ORDER BY (mg.naziv IS NULL), mg.naziv, r.grupa`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/katalog — sastavi katalog i vrati javni token (link za slanje)
router.post('/', smijeSlati, async (req, res) => {
  const u = req.session.user;
  const { tip_kupca_id, grupe, objekt_id, prikaz, sa_cijenama, naslov, kupac_naziv, samo_dostupno, debljine, sifre } = req.body || {};
  /* Grupe materijala trebaju samo ako materijali ulaze u katalog. Katalog sastavljen
     iskljucivo od gotovih proizvoda nema nijednu grupu — i to je ispravno. */
  const staUlazi = ['materijali', 'gotovi', 'oba'].includes(req.body?.sta_ulazi)
    ? req.body.sta_ulazi : 'materijali';
  const izabraniGotovi = Array.isArray(req.body?.gotovi_ids)
    ? req.body.gotovi_ids.map(x => parseInt(x)).filter(Boolean) : [];

  if (staUlazi === 'gotovi') {
    if (!izabraniGotovi.length)
      return res.status(400).json({ error: 'Izaberite bar jedan gotov proizvod.' });
  } else if (!Array.isArray(grupe) || !grupe.length) {
    return res.status(400).json({ error: 'Izaberite bar jednu grupu proizvoda.' });
  }
  try {
    let tipNaziv = null;
    if (tip_kupca_id) {
      const t = await pool.query('SELECT naziv FROM tipovi_kupaca WHERE id=$1', [tip_kupca_id]);
      tipNaziv = t.rows[0]?.naziv || null;
    }
    const token = crypto.randomBytes(16).toString('hex');
    const r = await pool.query(
      `INSERT INTO katalozi (javni_token, tip_kupca_id, tip_naziv, grupe, objekt_id,
                             prikaz, sa_cijenama, naslov, kupac_naziv, kreirao_id, kreirao_ime, samo_dostupno, debljine, sifre,
                              gotovi_proizvodi, gotovi_ids, sta_ulazi)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, javni_token`,
      [token, tip_kupca_id || null, tipNaziv, grupe, objekt_id || null,
       prikaz === 'lista' ? 'lista' : 'mreza', sa_cijenama !== false,
       naslov || null, kupac_naziv || null, u.id, u.ime_prezime, samo_dostupno === true,
       Array.isArray(debljine)&&debljine.length ? debljine.map(Number) : null,
       Array.isArray(sifre)&&sifre.length ? sifre : null,
       /* Gotovi proizvodi: koji su izabrani i sta uopste ulazi u katalog */
       staUlazi === 'gotovi' || staUlazi === 'oba',
       izabraniGotovi.length ? izabraniGotovi : null,
       staUlazi]
    );
    res.status(201).json({ ok: true, token: r.rows[0].javni_token, id: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/katalog/pregled — sadrzaj PRIJE slanja (da posiljalac vidi sta salje)
router.get('/pregled', smijeSlati, async (req, res) => {
  try {
    const grupe = (req.query.grupe || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!grupe.length) return res.json({ stavke: [] });
    const podaci = await ucitajStavke({
      grupe,
      objekt_id: req.query.objekt_id ? parseInt(req.query.objekt_id) : null,
      tip_kupca_id: req.query.tip_kupca_id ? parseInt(req.query.tip_kupca_id) : null,
      samo_dostupno: req.query.samo_dostupno === 'true',
      debljine: (req.query.debljine || '').split(',').filter(Boolean),
      sifre: (req.query.sifre || '').split(',').filter(Boolean),
    });
    res.json(podaci);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Zajednicko ucitavanje stavki — koriste ga i pregled i javni prikaz.
async function ucitajStavke({ grupe, objekt_id, tip_kupca_id, samo_dostupno, debljine, sifre }) {
  /* Katalog samo od gotovih proizvoda nema nijednu grupu materijala — tad se ne ide
     u bazu uopste, umjesto da upit vrati prazno. */
  if (!Array.isArray(grupe) || !grupe.length)
    return { stavke: [], sa_pdv: false, pdv_stopa: await pdvStopa() };

  let tip = null;
  if (tip_kupca_id) {
    const t = await pool.query('SELECT * FROM tipovi_kupaca WHERE id=$1', [tip_kupca_id]);
    tip = t.rows[0] || null;
  }
  const popusti = await pool.query(
    'SELECT * FROM kolicinski_popusti WHERE tip_kupca_id IS NULL OR tip_kupca_id=$1',
    [tip_kupca_id || null]
  );
  const stopa = await pdvStopa();

  const vals = [grupe];
  let objektUslov = '';
  if (objekt_id) { vals.push(objekt_id); objektUslov = `AND rp.objekt_id = $${vals.length}`; }

  // Dodatni filteri — ne mora cijela grupa u katalog (npr. samo debljina 3 cm).
  let dodatni = '';
  const listaDebljina = (debljine || []).map(x => parseFloat(x)).filter(x => !isNaN(x));
  if (listaDebljina.length) {
    vals.push(listaDebljina);
    dodatni += ` AND r.debljina_cm = ANY($${vals.length}::numeric[])`;
  }
  const listaSifri = (sifre || []).map(s => String(s).trim()).filter(Boolean);
  if (listaSifri.length) {
    vals.push(listaSifri);
    dodatni += ` AND r.sifra = ANY($${vals.length}::text[])`;
  }

  // DISTINCT ON (r.id) — jedan red PO ARTIKLU. Bez ovoga, ako objekt_id nije zadat,
  // spajanje sa roba_pj vraca po jedan red za SVAKU PJ u kojoj artikal postoji, pa se
  // isti artikal u katalogu pojavljuje 2-3 puta. To je bio uzrok dupliranih stavki.
  // Kad objekt_id NIJE zadat, uzima se cijena iz PJ sa najvecim stanjem (najrelevantnija).
  const r = await pool.query(
    `SELECT DISTINCT ON (r.id)
            r.id, r.sifra, r.naziv, r.jed_mjera, r.grupa, r.debljina_cm,
            rp.cijena AS osnovica, rp.stanje,
            (SELECT COALESCE(thumb_url, url) FROM roba_slike WHERE roba_id=r.id AND glavna=true LIMIT 1) AS slika,
            (SELECT url FROM roba_slike WHERE roba_id=r.id AND glavna=true LIMIT 1) AS slika_puna,
            mg.naziv AS master_naziv
     FROM roba r
     JOIN roba_pj rp ON rp.roba_id = r.id ${objektUslov}
     LEFT JOIN grupa_master gm ON gm.grupa = r.grupa
     LEFT JOIN master_grupe mg ON mg.id = COALESCE(r.master_grupa_id, gm.master_grupa_id)
     WHERE r.aktivan = true AND r.grupa = ANY($1)
       ${samo_dostupno ? 'AND rp.stanje > 0' : ''}
       ${dodatni}
     ORDER BY r.id, rp.stanje DESC NULLS LAST`,
    vals
  );

  // Kupcu se NE prikazuje tacna kolicina — samo da li je dostupno. Zalihe su interna
  // informacija; kupcu je dovoljno da zna moze li kupiti.
  // Sortiranje po grupi i nazivu — radi se OVDJE jer DISTINCT ON zahtijeva da SQL
  // ORDER BY pocinje kolonom po kojoj se razlikuje (r.id).
  const redovi = r.rows.sort((a,b) =>
    String(a.grupa||'').localeCompare(String(b.grupa||''),'sr-Latn-BA') ||
    String(a.naziv||'').localeCompare(String(b.naziv||''),'sr-Latn-BA'));

  const stavke = redovi.map(s => {
    const c = izracunajCijenu(s.osnovica, tip, 1, popusti.rows, stopa);
    return {
      id: s.id, sifra: s.sifra, naziv: s.naziv, jed_mjera: s.jed_mjera,
      grupa: s.grupa, master_naziv: s.master_naziv, debljina_cm: s.debljina_cm,
      slika: s.slika, slika_puna: s.slika_puna,
      dostupno: parseFloat(s.stanje) > 0,
      cijena: c.konacna, cijena_bez_pdv: c.bez_pdv, pdv_iznos: c.pdv_iznos,
    };
  });
  return { stavke, tip_naziv: tip?.naziv || null, pdv_stopa: stopa, sa_pdv: !!tip?.dodaje_pdv };
}

module.exports = router;
module.exports.ucitajStavke = ucitajStavke;
