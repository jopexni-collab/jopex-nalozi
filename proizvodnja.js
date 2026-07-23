// routes/proizvodnja.js
const express = require('express');
const router = express.Router();
const pool = require('./db');

// Finansijske kolone - vide ih samo admini
const ADMIN_COLS = `
  p.ugovorena_suma, p.avans, p.avans_opis,
  (COALESCE(p.ugovorena_suma,0) - COALESCE(p.avans,0)) AS za_naplatu,
  p.naplata_detalji, p.naplaceno_fakturisano, p.dodatni_rad_napomena,
  ga.predano AS avans_predano, gn.predano AS naplata_predano
`;

// JOIN koji provjerava da li je gotovina za avans/naplatu ovog naloga
// već predata blagajniku (sve odgovarajuće stavke moraju biti predane)
const GOTOVINA_JOINS = `
  LEFT JOIN LATERAL (
    SELECT bool_and(predao_blagajniku) AS predano
    FROM gotovina g WHERE g.nalog_r_br = p.r_br::text AND g.opis LIKE 'Avans%'
  ) ga ON true
  LEFT JOIN LATERAL (
    SELECT bool_and(predao_blagajniku) AS predano
    FROM gotovina g WHERE g.nalog_r_br = p.r_br::text AND g.opis LIKE 'Naplata%'
  ) gn ON true
`;

// Tehničke kolone - vide ih svi
const BASE_COLS = `
  p.r_br, p.zadatak, p.prioritet, p.ugovorio_id, p.ugovorio,
  p.narucilac, p.materijal, p.status, p.pocetak, p.planirani_zavrsetak,
  (p.planirani_zavrsetak - CURRENT_DATE) AS broj_dana,
  p.gotovo, p.reklamacija_dodatni_rad, p.napomena,
  p.link_skica, p.link_ponuda, p.datum_kreiranja, p.nova_procjena,
  p.naplaceno, p.naplaceno_opis, COALESCE(p.stornirano,false) AS stornirano,
  COALESCE(p.izvor,'velika_ponuda') AS izvor
`;

// Finansijska polja (iz ADMIN_COLS) — vidljiva adminu, ILI osobi koja je upisana kao
// "ugovorio" za TAJ KONKRETAN nalog (npr. operater koji je na licu mjesta dogovorio
// uslugu i treba transparentno da upiše cijenu — ne vidi cijene TUĐIH naloga).
const FINANSIJSKA_POLJA = ['ugovorena_suma', 'avans', 'avans_opis', 'za_naplatu',
  'naplata_detalji', 'naplaceno_fakturisano', 'dodatni_rad_napomena',
  'avans_predano', 'naplata_predano'];

// Finansijska polja (iz ADMIN_COLS) — pravilo zavisi od TIPA naloga:
//   "Velika ponuda" (kreirana preko Generator ponuda alata) — SAMO admin i "Ponude"
//   dozvola (moze_ugovarati) vide finansije. Uska vidljivost, kao i do sad.
//   "Mala ponuda" (kreirana preko brze forme) — SVAKO ko uopšte radi sa nalozima
//   (Unos naloga / Mijenja status / Mijenja nalog) MOŽE VIDJETI finansije (treba da
//   zna cijenu da bi mogao da isporuči umjesto odsutnog kolege) — ali NE MOŽE MIJENJATI
//   (to ostaje admin/Ponude/kreator, vidi PATCH rutu ispod).
function filtrirajFinansije(rows, user) {
  return rows.map(row => {
    if (user?.rola === 'admin' || user?.moze_ugovarati) return row; // vidi sve, uvijek
    const jeMalaPonuda = row.izvor === 'mala_ponuda';
    const smijeCitati = jeMalaPonuda && !!(user?.unos_naloga || user?.izmjena_statusa || user?.izmjena_naloga);
    if (smijeCitati) return row;
    const kopija = { ...row };
    for (const polje of FINANSIJSKA_POLJA) delete kopija[polje];
    return kopija;
  });
}

// GET /api/proizvodnja - lista (admin vidi finansije svih; ostali vide finansije SAMO
// za naloge koje su sami ugovorili — vidi filtrirajFinansije iznad)
router.get('/', async (req, res) => {
  const user = req.session?.user;
  const cols = BASE_COLS + ',' + ADMIN_COLS;
  try {
    const r = await pool.query(
      `SELECT ${cols} FROM proizvodnja_jopex p ${GOTOVINA_JOINS} ORDER BY p.r_br DESC`
    );
    res.json(filtrirajFinansije(r.rows, user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri učitavanju naloga.' });
  }
});

// GET /api/proizvodnja/za-naplatu?q=ime - pretraga naloga po naručiocu SA otvorenim
// avansom/naplatom, za blagajnika koji direktno naplaćuje u blagajni (ne kroz lista.html).
// Dostupno i blagajniku (ne samo Ponude/admin) — bez ovoga blagajnik ne bi mogao ni da
// vidi koliko treba da naplati, iako mu je to posao.
router.get('/za-naplatu', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const smijeVidjeti = user.rola === 'admin' || user.moze_ugovarati || await jeBlagajnik(user.id);
  if (!smijeVidjeti) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const r = await pool.query(
      `SELECT r_br, narucilac, zadatak, ugovorena_suma, avans, avans_opis,
              (COALESCE(ugovorena_suma,0) - COALESCE(avans,0)) AS za_naplatu,
              naplaceno, naplaceno_opis
       FROM proizvodnja_jopex
       WHERE narucilac ILIKE $1 AND COALESCE(stornirano,false)=false
         AND COALESCE(ugovorena_suma,0) > 0
         AND (naplaceno = false OR naplaceno IS NULL)
       ORDER BY r_br DESC LIMIT 15`,
      [`%${q}%`]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/proizvodnja/:r_br - jedan nalog
router.get('/:r_br', async (req, res) => {
  const user = req.session?.user;
  const cols = BASE_COLS + ',' + ADMIN_COLS;
  try {
    const r = await pool.query(
      `SELECT ${cols} FROM proizvodnja_jopex p ${GOTOVINA_JOINS} WHERE p.r_br = $1`,
      [req.params.r_br]
    );
    if (!r.rows.length)
      return res.status(404).json({ error: 'Nalog nije pronađen.' });
    res.json(filtrirajFinansije(r.rows, user)[0]);
  } catch (err) {
    res.status(500).json({ error: 'Greška.' });
  }
});


// POST /api/proizvodnja - novi nalog
// Poziva se i iz web forme i iz JoPeX HTML (usvajanje ponude)
router.post('/', async (req, res) => {
  const user = req.session?.user;
  const {
    zadatak, prioritet, ugovorio_id, narucilac, materijal, status,
    pocetak, planirani_zavrsetak, napomena, link_skica, link_ponuda,
    gotovo, reklamacija_dodatni_rad, r_br_import,
  } = req.body || {};

  if (!zadatak?.trim())
    return res.status(400).json({ error: '"zadatak" je obavezno polje.' });

  // Cijenu (ugovorena_suma/avans) smije upisati bilo ko ko kreira nalog — pošto je BAŠ ON
  // "Ugovorio" na ovom nalogu (vidi ispod), po istom principu kao vidljivost/uređivanje
  // kasnije (vidi filtrirajFinansije).
  const smijeCijenu = !!user;
  const ugovorena_suma = smijeCijenu ? req.body.ugovorena_suma : undefined;
  const avans = smijeCijenu ? req.body.avans : undefined;

  // "Ugovorio" = "kreirao" (namjerno isti koncept, nema odvojenog polja). Admin i "Ponude"
  // dozvola smiju izabrati BILO KOGA kao Ugovorio (dogovaraju poslove i za druge). Obični
  // operater automatski POSTAJE Ugovorio na svom novom nalogu — ne bira se, ne može
  // dodijeliti tuđe ime (spriječava da neko "otključa" vidljivost tuđeg naloga).
  const smijeBiratiUgovorio = user?.rola === 'admin' || !!user?.moze_ugovarati;
  const stvarniUgovorioId = smijeBiratiUgovorio ? (ugovorio_id || user?.id || null) : (user?.id || null);

  // "Velika ponuda" = stiglo preko Generator ponuda alata (API ključ, ne prava sesija).
  // "Mala ponuda" = neko se stvarno prijavio i popunio brzu formu (index.html).
  const izvorNaloga = user?.izAPIKljuca ? 'velika_ponuda' : 'mala_ponuda';

  try {
    let ugovorioIme = null;
    if (stvarniUgovorioId === user?.id) {
      ugovorioIme = user?.ime_prezime || null;
    } else if (stvarniUgovorioId) {
      const emp = await pool.query(
        `SELECT ime_prezime FROM zaposleni
         WHERE id = $1 AND aktivan = true`,
        [stvarniUgovorioId]
      );
      if (emp.rows.length) ugovorioIme = emp.rows[0].ime_prezime;
    }

    // Ako je import sa originalnim R.Br., upiši ga direktno
    let insertQuery, insertVals;
    if (r_br_import) {
      insertQuery = `INSERT INTO proizvodnja_jopex
        (r_br, zadatak, prioritet, ugovorio_id, ugovorio, narucilac, materijal,
         status, pocetak, planirani_zavrsetak, napomena, link_skica,
         link_ponuda, ugovorena_suma, avans, gotovo, reklamacija_dodatni_rad, izvor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (r_br) DO NOTHING
       RETURNING r_br, zadatak, narucilac, ugovorena_suma, status`;
      insertVals = [
        r_br_import,
        zadatak, prioritet || 'Normal',
        stvarniUgovorioId, ugovorioIme,
        narucilac || null, materijal || null,
        status || 'Nije Započeto',
        pocetak || null, planirani_zavrsetak || null,
        napomena || null, link_skica || null, link_ponuda || null,
        ugovorena_suma ?? 0, avans ?? 0,
        gotovo || false, reklamacija_dodatni_rad || null,
        izvorNaloga,
      ];
    } else {
      insertQuery = `INSERT INTO proizvodnja_jopex
        (zadatak, prioritet, ugovorio_id, ugovorio, narucilac, materijal,
         status, pocetak, planirani_zavrsetak, napomena, link_skica,
         link_ponuda, ugovorena_suma, avans, gotovo, reklamacija_dodatni_rad, izvor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING r_br, zadatak, narucilac, ugovorena_suma, status`;
      insertVals = [
        zadatak, prioritet || 'Normal',
        stvarniUgovorioId, ugovorioIme,
        narucilac || null, materijal || null,
        status || 'Nije Započeto',
        pocetak || new Date().toISOString().split('T')[0], planirani_zavrsetak || null,
        napomena || null, link_skica || null, link_ponuda || null,
        ugovorena_suma ?? 0, avans ?? 0,
        gotovo || false, reklamacija_dodatni_rad || null,
        izvorNaloga,
      ];
    }
    const r = await pool.query(insertQuery, insertVals);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri upisu: ' + err.message });
  }
});

// Pomoćne funkcije za prepoznavanje gotovinskog opisa ("got Boban 15/7"...)
function jeGotovina(val) {
  return /^got\b/i.test(String(val || '').trim());
}
function izvuciPrimio(val) {
  const m = /^got\s+(\S+)/i.exec(String(val || '').trim());
  return m ? m[1] : 'Nepoznato';
}
async function jeBlagajnik(userId) {
  const r = await pool.query('SELECT 1 FROM blagajnici_pj WHERE zaposleni_id=$1 LIMIT 1', [userId]);
  return r.rows.length > 0;
}

// POST /api/proizvodnja/:r_br/naplata-blagajna - blagajnik DIREKTNO naplaćuje avans ili
// cijeli iznos u blagajni. Za razliku od uređivanja preko lista.html (koje samo upisuje
// opis-tekst i ČEKA da neko naknadno klikne "Predano"), OVO odmah upisuje gotovinski zapis
// KAO PREDAT — blagajnik je u ISTOM trenutku i naplatio i primio, nema smisla da "preda
// sam sebi" naknadno.
router.post('/:r_br/naplata-blagajna', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const smijeNaplatiti = user.rola === 'admin' || user.moze_ugovarati || await jeBlagajnik(user.id);
  if (!smijeNaplatiti) return res.status(403).json({ error: 'Nema pristupa.' });

  const { tip, iznos, objekt_naziv } = req.body; // tip: 'avans' | 'sve'; objekt_naziv: opciono
  // — PJ koji blagajnik TRENUTNO ima otvoren (novac fizički ide u tu kasu, iako nalog
  // sam po sebi nije vezan ni za jedan PJ).
  const iznosNum = parseFloat(iznos);
  if (!['avans', 'sve'].includes(tip) || !(iznosNum > 0))
    return res.status(400).json({ error: 'Neispravni podaci (tip mora biti avans/sve, iznos > 0).' });

  try {
    const n = await pool.query(
      'SELECT r_br, narucilac, ugovorena_suma, avans FROM proizvodnja_jopex WHERE r_br=$1',
      [req.params.r_br]
    );
    if (!n.rows.length) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    const nalog = n.rows[0];
    const opisMarker = `got ${user.ime_prezime}`;
    const napomenaOpisa = tip === 'avans'
      ? `Avans - nalog #${nalog.r_br}${nalog.narucilac ? ' (' + nalog.narucilac + ')' : ''} — naplaćeno direktno u blagajni`
      : `Naplata - nalog #${nalog.r_br}${nalog.narucilac ? ' (' + nalog.narucilac + ')' : ''} — naplaćeno direktno u blagajni`;

    if (tip === 'avans') {
      await pool.query('DELETE FROM gotovina WHERE nalog_r_br=$1::text AND opis LIKE \'Avans%\'', [String(nalog.r_br)]);
      await pool.query(
        `UPDATE proizvodnja_jopex SET avans=$1, avans_opis=$2 WHERE r_br=$3`,
        [iznosNum, opisMarker, nalog.r_br]
      );
    } else {
      await pool.query('DELETE FROM gotovina WHERE nalog_r_br=$1::text AND opis LIKE \'Naplata%\'', [String(nalog.r_br)]);
      await pool.query(
        `UPDATE proizvodnja_jopex SET naplaceno=true, naplaceno_opis=$1 WHERE r_br=$2`,
        [opisMarker, nalog.r_br]
      );
    }

    const g = await pool.query(
      `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv)
       VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5)
       RETURNING id`,
      [iznosNum, user.ime_prezime, String(nalog.r_br), napomenaOpisa, objekt_naziv || null]
    );

    res.json({ ok: true, gotovina_id: g.rows[0].id, nalog_r_br: nalog.r_br });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

// PATCH /api/proizvodnja/:r_br - djelimično ažuriranje
router.patch('/:r_br', async (req, res) => {
  const user = req.session?.user;
  const isAdmin = user?.rola === 'admin';

  const postojeciRes = await pool.query('SELECT ugovorio_id FROM proizvodnja_jopex WHERE r_br=$1', [req.params.r_br]);
  if (!postojeciRes.rows.length) return res.status(404).json({ error: 'Nalog nije pronađen.' });
  const jeSvoj = postojeciRes.rows[0].ugovorio_id === user?.id;

  // "Ponude" dozvola (moze_ugovarati) — vidi/uređuje finansije SVIH naloga. Inače, samo
  // ako je osoba upisana kao "Ugovorio" ZA TAJ nalog (kreirao=ugovorio, isti koncept).
  const smijeFinansije = isAdmin || !!user?.moze_ugovarati || jeSvoj;

  // Opšta polja (zadatak, naručilac, itd.) — traži "Mijenja nalog" dozvolu, OSIM na
  // SOPSTVENOM nalogu, koji vlasnik smije uređivati bez obzira na tu dozvolu (izuzetak).
  const smijeOpsta = isAdmin || !!user?.izmjena_naloga || jeSvoj;
  // Status polja — traži "Mijenja status" dozvolu, isti izuzetak za sopstveni nalog.
  const smijeStatus = isAdmin || !!user?.izmjena_statusa || jeSvoj;

  const OPSTA_POLJA = [
    'zadatak','prioritet','narucilac','materijal','pocetak',
    'planirani_zavrsetak','napomena','link_skica','link_ponuda',
  ];
  const STATUS_POLJA = ['status', 'gotovo', 'reklamacija_dodatni_rad', 'nova_procjena'];
  const ALLOWED_ADMIN = [
    'ugovorena_suma','avans','avans_opis','naplata_detalji',
    'naplaceno_fakturisano','dodatni_rad_napomena','naplaceno','naplaceno_opis',
  ];

  const allowed = [
    ...(smijeOpsta ? OPSTA_POLJA : []),
    ...(smijeStatus ? STATUS_POLJA : []),
    ...(smijeFinansije ? ALLOWED_ADMIN : []),
  ];
  const sets = [], vals = [];
  let i = 1;

  for (const key of allowed) {
    if (key in req.body) { sets.push(`${key} = $${i++}`); vals.push(req.body[key]); }
  }

  // Poseban slučaj: ugovorio_id (treba validaciju + upisati i ugovorio tekst) — SAMO
  // admin smije da postavi/promijeni ko je ugovorio (fiksira se jednom, operater ga sam
  // sebi ne smije dodijeliti da bi "otključao" tuđ nalog).
  if (isAdmin && req.body.ugovorio_id !== undefined) {
    let ugovorioIme = null;
    if (req.body.ugovorio_id) {
      const emp = await pool.query(
        `SELECT ime_prezime FROM zaposleni WHERE id=$1 AND moze_ugovarati=true AND aktivan=true`,
        [req.body.ugovorio_id]
      );
      if (!emp.rows.length)
        return res.status(400).json({ error: 'Osoba ne može biti "Ugovorio".' });
      ugovorioIme = emp.rows[0].ime_prezime;
    }
    sets.push(`ugovorio_id = $${i++}`); vals.push(req.body.ugovorio_id || null);
    sets.push(`ugovorio = $${i++}`);    vals.push(ugovorioIme);
  }

  if (!sets.length)
    return res.status(400).json({ error: 'Nema polja za izmjenu.' });

  // Ako mijenjamo avans_opis ili naplaceno_opis, treba nam stanje PRIJE izmjene
  // da bismo upis u blagajnu napravili samo jednom (kad se vrijednost stvarno promijeni)
  const trebaProvjeruGotovine = smijeFinansije && ('avans_opis' in req.body || 'naplaceno_opis' in req.body);
  let staro = null;
  if (trebaProvjeruGotovine) {
    const s = await pool.query(
      `SELECT avans_opis, naplaceno_opis FROM proizvodnja_jopex WHERE r_br = $1`,
      [req.params.r_br]
    );
    staro = s.rows[0] || {};
  }

  vals.push(req.params.r_br);
  try {
    const r = await pool.query(
      `UPDATE proizvodnja_jopex SET ${sets.join(', ')} WHERE r_br = $${i}
       RETURNING r_br, status, avans_opis, naplaceno_opis, avans, ugovorena_suma, narucilac`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    const novo = r.rows[0];

    if (trebaProvjeruGotovine) {
      // AVANS -> ako se avans_opis promijenio, prvo ukloni STARI gotovinski zapis (ako
      // postoji) — bez obzira da li se sad prebacuje NA gotovinu, SA gotovine na banku,
      // ili samo mijenja ko je primio. Bez ovoga, svaki povratak na "gotovina" pravi
      // duplikat, a prebacivanje na "banka" ostavlja stari (sad netačan) zapis u blagajni.
      const avansIznos = Number(novo.avans || 0);
      if ('avans_opis' in req.body && novo.avans_opis !== staro.avans_opis) {
        await pool.query(
          `DELETE FROM gotovina WHERE nalog_r_br = $1::text AND opis LIKE 'Avans%'`,
          [String(novo.r_br)]
        );
        if (jeGotovina(novo.avans_opis) && avansIznos > 0) {
          await pool.query(
            `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis)
             VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4)`,
            [
              avansIznos,
              izvuciPrimio(novo.avans_opis),
              String(novo.r_br),
              `Avans - nalog #${novo.r_br}${novo.narucilac ? ' (' + novo.narucilac + ')' : ''}`,
            ]
          );
        }
      }

      // NAPLATA (preostali iznos) -> ista logika: prvo obriši stari zapis, pa eventualno upiši novi.
      const zaNaplatu = Number(novo.ugovorena_suma || 0) - Number(novo.avans || 0);
      if ('naplaceno_opis' in req.body && novo.naplaceno_opis !== staro.naplaceno_opis) {
        await pool.query(
          `DELETE FROM gotovina WHERE nalog_r_br = $1::text AND opis LIKE 'Naplata%'`,
          [String(novo.r_br)]
        );
        if (jeGotovina(novo.naplaceno_opis) && zaNaplatu > 0) {
          await pool.query(
            `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis)
             VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4)`,
            [
              zaNaplatu,
              izvuciPrimio(novo.naplaceno_opis),
              String(novo.r_br),
              `Naplata - nalog #${novo.r_br}${novo.narucilac ? ' (' + novo.narucilac + ')' : ''}`,
            ]
          );
        }
      }
    }

    res.json(novo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri ažuriranju: ' + err.message });
  }
});

// DELETE /api/proizvodnja/:r_br - STORNIRA nalog (samo admin) — NE BRIŠE red, poništava
// (ne briše) vezane gotovinske zapise (avans/naplata) kroz reverzne stavke. Isti URL/dugme
// na frontu nastavlja da radi bez izmjene — samo je logika iza njega sad bezbjednija.
router.delete('/:r_br', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Nema pristupa.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM proizvodnja_jopex WHERE r_br=$1 FOR UPDATE', [req.params.r_br]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nije pronađen.' }); }
    const nalog = r.rows[0];
    if (nalog.stornirano) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nalog je već storniran.' }); }

    // Poništi (ne briši) sve gotovinske zapise vezane za ovaj nalog — reverzni red za
    // svaki postojeći (avans, naplata, i eventualne kasnije korekcije).
    const gotRes = await client.query(
      `SELECT * FROM gotovina WHERE nalog_r_br = $1::text AND izvor = 'Proizvodnja'`,
      [String(nalog.r_br)]
    );
    for (const g of gotRes.rows) {
      await client.query(
        `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, nalog_r_br)
         VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4)`,
        [-g.iznos, req.session.user.ime_prezime, `STORNO — ${g.opis}`, String(nalog.r_br)]
      );
    }

    await client.query('UPDATE proizvodnja_jopex SET stornirano = true WHERE r_br=$1', [nalog.r_br]);
    await client.query('COMMIT');
    res.json({ ok: true, stornirano: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Greška: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
