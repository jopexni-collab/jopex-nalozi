// routes/proizvodnja.js
const express = require('express');
const router = express.Router();
const pool = require('./db');
const multer = require('multer');
const { uploadFile } = require('./storage');

const uploadSlika = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Finansijske kolone - vide ih samo admini
const ADMIN_COLS = `
  p.ugovorena_suma, p.avans, p.avans_opis, p.naplaceno_iznos,
  (COALESCE(p.ugovorena_suma,0) - COALESCE(p.avans,0) - COALESCE(p.naplaceno_iznos,0)) AS za_naplatu,
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
  COALESCE(p.izvor,'velika_ponuda') AS izvor,
  (SELECT COALESCE(thumb_url, url) FROM nalog_slike WHERE nalog_r_br=p.r_br AND glavna=true LIMIT 1) AS glavna_slika,
  (SELECT COUNT(*) FROM nalog_slike WHERE nalog_r_br=p.r_br) AS broj_slika
`;

// Finansijska polja (iz ADMIN_COLS) — vidljiva adminu, ILI osobi koja je upisana kao
// "ugovorio" za TAJ KONKRETAN nalog (npr. operater koji je na licu mjesta dogovorio
// uslugu i treba transparentno da upiše cijenu — ne vidi cijene TUĐIH naloga).
const FINANSIJSKA_POLJA = ['ugovorena_suma', 'avans', 'avans_opis', 'naplaceno_iznos', 'za_naplatu',
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
    // "Kreirao vidi svoje" — SAMO ako je BAŠ ON ugovorio (kreirao) TAJ KONKRETAN nalog.
    // Ranija verzija je pogrešno davala pristup SVIM mala_ponuda nalozima svakome ko ima
    // unos_naloga/izmjena_statusa/izmjena_naloga, bez provjere vlasništva — ozbiljan
    // propust u privatnosti (Rade je vidio tuđe cifre nakon uvoza 341 naloga).
    if (user?.id && row.ugovorio_id === user.id) return row;
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

// GET /api/proizvodnja/za-naplatu?q=ime ILI broj naloga - pretraga naloga SA otvorenim
// avansom/naplatom, za blagajnika koji direktno naplaćuje u blagajni (ne kroz lista.html).
// Dostupno i blagajniku (ne samo Ponude/admin) — bez ovoga blagajnik ne bi mogao ni da
// vidi koliko treba da naplati, iako mu je to posao.
// NAPOMENA: q se upoređuje i sa narucilac (ILIKE, djelimično poklapanje) I sa r_br
// (tačno poklapanje, kao tekst) — inače kucanje broja naloga (npr. "385") ne pogađa
// ništa, jer narucilac ILIKE '%385%' skoro nikad neće postojati u imenu kupca.
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
              (COALESCE(ugovorena_suma,0) - COALESCE(avans,0) - COALESCE(naplaceno_iznos,0)) AS za_naplatu,
              naplaceno, naplaceno_opis
       FROM proizvodnja_jopex
       WHERE (narucilac ILIKE $1 OR r_br::text = $2)
         AND COALESCE(stornirano,false)=false
         AND COALESCE(ugovorena_suma,0) > 0
         AND (naplaceno = false OR naplaceno IS NULL)
       ORDER BY r_br DESC LIMIT 15`,
      [`%${q}%`, q]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/proizvodnja/komentari — SVI komentari odjednom (bulk, da lista.html ne mora
// da pravi poziv po redu/koloni — jedan poziv za cijelu vidljivu tabelu). MORA biti
// registrovano PRIJE '/:r_br' ispod, inače bi Express "komentari" protumačio kao r_br.
router.get('/komentari', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  try {
    const r = await pool.query('SELECT r_br, kolona, tekst, autor_ime, kreirano, azurirano FROM celija_komentari');
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

// GET /api/proizvodnja/:r_br/status-log?polje=X — audit trag za desni-klik meni u
// lista.html (ko/kad/šta je promijenio). Opciono filtrira SAMO jedno polje na serveru
// (manje podataka po zahtjevu, umjesto da fronta povuče sve pa filtrira lokalno).
router.get('/:r_br/status-log', async (req, res) => {
  try {
    const { polje } = req.query;
    const r = await pool.query(
      `SELECT id, kolona, stara_vrijednost, nova_vrijednost, korisnik_ime, kada
       FROM status_promjene_log WHERE r_br=$1 ${polje ? 'AND kolona=$2' : ''} ORDER BY kada DESC LIMIT 20`,
      polje ? [req.params.r_br, polje] : [req.params.r_br]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Polja čija je stvarna kolona u proizvodnja_jopex BOOLEAN tip (log ih čuva kao tekst
// 'true'/'false' — undo mora pravilno pretvoriti nazad u pravi boolean).
const BOOLEAN_POLJA = ['gotovo', 'naplaceno'];

// Whitelist SVIH kolona koje undo smije da mijenja — log.kolona se koristi direktno u SQL
// (dinamičko ime kolone), pa MORA proći kroz ovu provjeru prije upotrebe (odbrana od
// SQL injekcije, čak i ako bi status_promjene_log ikad sadržao neočekivan unos).
const UNDO_DOZVOLJENE_KOLONE = [
  'status', 'gotovo', 'reklamacija_dodatni_rad', 'nova_procjena',
  'zadatak', 'prioritet', 'narucilac', 'materijal', 'pocetak', 'planirani_zavrsetak',
  'napomena', 'link_skica', 'link_ponuda', 'ugovorio',
  'ugovorena_suma', 'avans', 'naplata_detalji', 'naplaceno_fakturisano',
  'dodatni_rad_napomena', 'naplaceno',
];

// POST /api/proizvodnja/:r_br/undo/:logId — vraća JEDNO polje na vrijednost koju je imalo
// PRIJE te konkretne promjene (stara_vrijednost iz log reda). Dozvoljeno SAMO ako je ovo
// još uvijek NAJNOVIJA promjena za to polje (spriječava zbrku ako je neko posle toga opet
// mijenjao — undo bi "preskočio" međukorak). Sam undo se TAKOĐE loguje (novi red u
// status_promjene_log), da audit trag ostane potpun i taj korak.
router.post('/:r_br/undo/:logId', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const logRes = await pool.query(
      `SELECT * FROM status_promjene_log WHERE id=$1 AND r_br=$2`,
      [req.params.logId, req.params.r_br]
    );
    if (!logRes.rows.length) return res.status(404).json({ error: 'Zapis u istoriji nije pronađen.' });
    const log = logRes.rows[0];

    const najnoviji = await pool.query(
      `SELECT id FROM status_promjene_log WHERE r_br=$1 AND kolona=$2 ORDER BY kada DESC LIMIT 1`,
      [req.params.r_br, log.kolona]
    );
    if (najnoviji.rows[0]?.id !== log.id) {
      return res.status(409).json({ error: 'Ovo više nije najnovija promjena za ovo polje (neko je posle toga opet menjao) — undo nije moguć bez preskakanja koraka.' });
    }

    if (!UNDO_DOZVOLJENE_KOLONE.includes(log.kolona)) {
      return res.status(400).json({ error: 'Ovo polje ne podržava undo.' });
    }

    let vrijednostZaUpis = log.stara_vrijednost;
    if (BOOLEAN_POLJA.includes(log.kolona)) vrijednostZaUpis = vrijednostZaUpis === 'true';

    await pool.query(
      `UPDATE proizvodnja_jopex SET ${log.kolona} = $1 WHERE r_br = $2`,
      [vrijednostZaUpis, req.params.r_br]
    );
    await pool.query(
      `INSERT INTO status_promjene_log (r_br, kolona, stara_vrijednost, nova_vrijednost, korisnik_id, korisnik_ime)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.r_br, log.kolona, log.nova_vrijednost, log.stara_vrijednost, user.id, user.ime_prezime + ' (undo)']
    );

    res.json({ ok: true, kolona: log.kolona, vraceno_na: log.stara_vrijednost });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// POST /api/proizvodnja - novi nalog
// Poziva se i iz web forme i iz JoPeX HTML (usvajanje ponude)
router.post('/', async (req, res) => {
  const user = req.session?.user;
  const {
    zadatak, prioritet, ugovorio_id, narucilac, materijal, status,
    pocetak, planirani_zavrsetak, napomena, link_skica, link_ponuda,
    gotovo, reklamacija_dodatni_rad, r_br_import, iz_generatora_ponuda, kategorija_bonus_id,
    naplaceno_iznos, naplaceno_fakturisano,
  } = req.body || {};

  if (!zadatak?.trim())
    return res.status(400).json({ error: '"zadatak" je obavezno polje.' });

  // KRITIČNO: "Usvoji ponudu → Nalog" (Generator) smije da ZAVRŠI SAMO admin ili "Ponude
  // sve" (moze_ugovarati). Osoba sa "Unos naloga" (bez moze_ugovarati) smije da PRAVI i
  // ČUVA ponudu (cloud/R2), ali NE smije sama da je usvoji u stvaran radni nalog — mora
  // neko sa pravom da to pregleda i potvrdi. Frontend sakriva dugme za takve korisnike,
  // ali to SAMO PO SEBI nije dovoljno (neko bi mogao pozvati API direktno) — zato je
  // provjera i OVDJE, na backend-u, gdje se stvarno ne može zaobići.
  if (iz_generatora_ponuda && user?.rola !== 'admin' && !user?.moze_ugovarati) {
    return res.status(403).json({
      error: 'Nemate pravo da usvojite ponudu u radni nalog. Sačuvajte je (☁ Sačuvaj) da je neko sa pravom pregleda i usvoji.',
    });
  }

  // Cijenu (ugovorena_suma/avans) smije upisati bilo ko ko kreira nalog — pošto je BAŠ ON
  // "Ugovorio" na ovom nalogu (vidi ispod), po istom principu kao vidljivost/uređivanje
  // kasnije (vidi filtrirajFinansije).
  const smijeCijenu = !!user;
  const ugovorena_suma = smijeCijenu ? req.body.ugovorena_suma : undefined;
  const avans = smijeCijenu ? req.body.avans : undefined;
  const naplacenoIznosVal = smijeCijenu ? (naplaceno_iznos ?? 0) : 0;
  const naplacenoFakturisanoVal = smijeCijenu ? !!naplaceno_fakturisano : false;

  // "Ugovorio" = "kreirao" (namjerno isti koncept, nema odvojenog polja). Admin i "Ponude"
  // dozvola smiju izabrati BILO KOGA kao Ugovorio (dogovaraju poslove i za druge). Obični
  // operater automatski POSTAJE Ugovorio na svom novom nalogu — ne bira se, ne može
  // dodijeliti tuđe ime (spriječava da neko "otključa" vidljivost tuđeg naloga).
  // IZUZETAK — uvoz (r_br_import): NE smije tiho "postati" osoba koja pokreće uvoz kad
  // ime iz fajla nije upareno — bolje prazno (istinito nepoznato) nego pogrešno ime.
  const smijeBiratiUgovorio = user?.rola === 'admin' || !!user?.moze_ugovarati;
  const stvarniUgovorioId = r_br_import
    ? (ugovorio_id || null)
    : smijeBiratiUgovorio ? (ugovorio_id || user?.id || null) : (user?.id || null);

  // "Velika ponuda" = stiglo preko Generator ponuda alata. NE oslanjamo se na tip
  // autentifikacije (API ključ vs sesija) — ako je osoba koja koristi Generator ponuda
  // SLUČAJNO već ulogovana u istom browseru (obična sesija), middleware tiho koristi NJENU
  // sesiju umjesto API ključa, pa bi ovo POGREŠNO postalo "mala_ponuda" (široko vidljivo).
  // Umjesto toga, ponude.html EKSPLICITNO šalje `iz_generatora_ponuda: true` u svakom
  // zahtjevu — to je pouzdan signal bez obzira ko/kako je autentifikovan.
  const izvorNaloga = iz_generatora_ponuda ? 'velika_ponuda' : 'mala_ponuda';

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
         link_ponuda, ugovorena_suma, avans, gotovo, reklamacija_dodatni_rad, izvor, kategorija_bonus_id,
         naplaceno_iznos, naplaceno_fakturisano, naplaceno)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
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
        izvorNaloga, kategorija_bonus_id || null,
        naplacenoIznosVal, naplacenoFakturisanoVal, naplacenoIznosVal > 0,
      ];
    } else {
      insertQuery = `INSERT INTO proizvodnja_jopex
        (zadatak, prioritet, ugovorio_id, ugovorio, narucilac, materijal,
         status, pocetak, planirani_zavrsetak, napomena, link_skica,
         link_ponuda, ugovorena_suma, avans, gotovo, reklamacija_dodatni_rad, izvor, kategorija_bonus_id,
         naplaceno_iznos, naplaceno_fakturisano, naplaceno)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
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
        izvorNaloga, kategorija_bonus_id || null,
        naplacenoIznosVal, naplacenoFakturisanoVal, naplacenoIznosVal > 0,
      ];
    }
    const r = await pool.query(insertQuery, insertVals);
    if (r.rows.length) {
      // KRITIČNO: bez ovoga, istorija za polje koje NIKO nikad nije naknadno menjao
      // ostaje potpuno PRAZNA — nema traga ni ko je originalno uneo tu vrednost. Ovo
      // upisuje POČETNO stanje za sva polja koja audit trag prati (uključujući
      // finansijska), tretirano kao "promena" od praznog ka unesenoj vrednosti — tako da
      // "Istorija promjena" UVEK ima bar jedan red: ko je nalog napravio i sa čim.
      const rBrNovi = r.rows[0].r_br;
      const pocetnaPolja = {
        zadatak, prioritet: prioritet || 'Normal', narucilac, materijal,
        status: status || 'Nije Započeto', pocetak, planirani_zavrsetak, napomena,
        gotovo: gotovo || false, reklamacija_dodatni_rad,
        ugovorena_suma: ugovorena_suma ?? 0, avans: avans ?? 0,
      };
      for (const [kolona, vrijednost] of Object.entries(pocetnaPolja)) {
        if (vrijednost === null || vrijednost === undefined || vrijednost === '') continue;
        await pool.query(
          `INSERT INTO status_promjene_log (r_br, kolona, stara_vrijednost, nova_vrijednost, korisnik_id, korisnik_ime)
           VALUES ($1,$2,NULL,$3,$4,$5)`,
          [rBrNovi, kolona, String(vrijednost), user?.id || null, user?.ime_prezime || (r_br_import ? 'Uvoz' : null)]
        );
      }
    }
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
// Sve naplate/avansi vezani za radne naloge (Proizvodnja) idu FIKSNO u blagajnu PJ
// Aleksandrovac — bez obzira kroz koji ekran/mehanizam su unijete (Nova naplata forma,
// ili direktno kucanje "got Ime" u lista.html) — po izričitom zahtjevu.
const PROIZVODNJA_PJ = 'PJ Aleksandrovac';
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

  const { tip, iznos } = req.body; // tip: 'avans' | 'sve'
  // Proizvodnja naplate UVIJEK idu u blagajnu PJ Aleksandrovac — FIKSNO, bez obzira koji
  // PJ tab blagajnik trenutno ima otvoren (po izričitom zahtjevu — glavna kasa/kancelarija).
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
    // Isti format kao "naplati-ostatak" ruta (got Ime DD.MM) — ranije je ovdje nedostajao
    // datum, pa se ponašalo drugačije zavisno od toga da li je naplata unesena direktno
    // ovde (iz blagajne) ili preko "naplati-ostatak" (iz liste) — sad su usaglašene.
    const danasKratko = new Date().toLocaleDateString('sr-Latn-BA', { day: '2-digit', month: '2-digit' });
    const opisMarker = `got ${user.ime_prezime} ${danasKratko}`;
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
      // naplaceno_iznos se postavlja na TAČAN preostali iznos (ne na uneseni iznosNum
      // direktno) — garantuje da za_naplatu ispravno padne na 0, bez obzira na sitna
      // odstupanja u unosu.
      const tacanPreostatak = parseFloat(nalog.ugovorena_suma || 0) - parseFloat(nalog.avans || 0);
      await pool.query(
        `UPDATE proizvodnja_jopex SET naplaceno=true, naplaceno_opis=$1, naplaceno_iznos=$2 WHERE r_br=$3`,
        [opisMarker, tacanPreostatak, nalog.r_br]
      );
    }

    const jeSamOnBlagajnik = await jeBlagajnik(user.id);
    // Ako je naplatu unio SAM blagajnik (Nenad, Marija...) — fizički drži novac u ruci,
    // pa ide ODMAH u "Predano" (nema smisla da čeka da "preda sam sebi"). Ako je unio
    // neko DRUGI (Ponude, admin — na daljinu, bez fizičke gotovine u ruci), ostaje "Nije
    // predano" dok blagajnik ne potvrdi da je stvarno primio.
    const g = jeSamOnBlagajnik
      ? await pool.query(
          `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv,
                                  predao_blagajniku, datum_predaje, preuzeo_ime)
           VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5, true, now(), $2)
           RETURNING id`,
          [iznosNum, user.ime_prezime, String(nalog.r_br), napomenaOpisa, PROIZVODNJA_PJ]
        )
      : await pool.query(
          `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv)
           VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5)
           RETURNING id`,
          [iznosNum, user.ime_prezime, String(nalog.r_br), napomenaOpisa, PROIZVODNJA_PJ]
        );

    res.json({ ok: true, gotovina_id: g.rows[0].id, nalog_r_br: nalog.r_br });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

// PATCH /api/proizvodnja/:r_br - djelimično ažuriranje
// POST /api/proizvodnja/:r_br/dodaj-ratu-avansa — DODAJE ratu uplate (avans ILI naplata
// ostatka — dijele isti rastući zbir "avans", jer su konceptualno isto: "novac uplaćen za
// ovaj nalog", samo u različitim fazama). Ne prepisuje prethodne rate — svaka ostaje svoj
// red u opisu I svoj zaseban zapis u blagajni, sa tačnim tragom ko je šta primio.
router.post('/:r_br/dodaj-ratu-avansa', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const { iznos, nacin, ime_gotovina, licno_preuzeo } = req.body; // nacin: bank kod ILI 'gotovina'
  const iznosNum = parseFloat(iznos);
  if (!(iznosNum > 0)) return res.status(400).json({ error: 'Iznos mora biti veći od 0.' });
  if (!nacin) return res.status(400).json({ error: 'Način uplate je obavezan.' });
  if (nacin === 'gotovina' && !(ime_gotovina || '').trim())
    return res.status(400).json({ error: 'Ime je obavezno za gotovinu.' });

  try {
    const nRes = await pool.query(
      'SELECT r_br, narucilac, ugovorio_id, avans, avans_opis, ugovorena_suma FROM proizvodnja_jopex WHERE r_br=$1',
      [req.params.r_br]
    );
    if (!nRes.rows.length) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    const nalog = nRes.rows[0];

    const isAdmin = user.rola === 'admin';
    const jeSvoj = nalog.ugovorio_id === user.id;
    const smijeFinansije = isAdmin || !!user.moze_ugovarati || jeSvoj;
    if (!smijeFinansije) return res.status(403).json({ error: 'Nemate pravo na finansije ovog naloga.' });

    const danasKratko = new Date().toLocaleDateString('sr-Latn-BA', { day: '2-digit', month: '2-digit' });
    const noviRed = nacin === 'gotovina'
      ? `got ${ime_gotovina.trim()} ${danasKratko} - ${iznosNum.toFixed(2)}`
      : `${nacin} ${danasKratko} - ${iznosNum.toFixed(2)}`;
    const noviOpis = nalog.avans_opis ? `${nalog.avans_opis}\n${noviRed}` : noviRed;
    const noviAvans = parseFloat(nalog.avans || 0) + iznosNum;
    // Kad zbir dostigne pun ugovoren iznos, automatski markiraj kao naplaćeno (zelena
    // kvačica) — ručno čekiranje više nije potrebno.
    const noviZaNaplatu = parseFloat(nalog.ugovorena_suma || 0) - noviAvans;
    const autoNaplaceno = noviZaNaplatu <= 0.005;

    await pool.query(
      'UPDATE proizvodnja_jopex SET avans=$1, avans_opis=$2, naplaceno=$3 WHERE r_br=$4',
      [noviAvans, noviOpis, autoNaplaceno, nalog.r_br]
    );

    if (nacin === 'gotovina') {
      const imeUneseno = ime_gotovina.trim();
      // KLJUČNO: "Predano" ide automatski SAMO ako je ulogovana osoba (a) STVARNO
      // registrovan blagajnik (ne bilo ko — admin/Ponude koji slučajno ima isto ime se NE
      // računa) I (b) upisala SVOJE vlastito ime (nema smisla da neko "preda sam sebi").
      // Ako bilo koji od ova dva uslova ne važi — ostaje "Nije predano" dok se ručno ne potvrdi.
      const mojeIme = (user.ime_prezime || '').trim().split(/\s+/)[0].toLowerCase();
      const jeVlastitoIme = imeUneseno.toLowerCase() === mojeIme;
      const jeIOnBlagajnik = await jeBlagajnik(user.id);
      const smijeAutoPredano = jeVlastitoIme && jeIOnBlagajnik;
      const opisGotovine = `Avans (rata) - nalog #${nalog.r_br}${nalog.narucilac ? ' (' + nalog.narucilac + ')' : ''}`;
      if (smijeAutoPredano) {
        await pool.query(
          `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv,
                                  predao_blagajniku, datum_predaje, preuzeo_ime)
           VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5, true, now(), $2)`,
          [iznosNum, imeUneseno, String(nalog.r_br), opisGotovine, PROIZVODNJA_PJ]
        );
      } else {
        await pool.query(
          `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv)
           VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5)`,
          [iznosNum, imeUneseno, String(nalog.r_br), opisGotovine, PROIZVODNJA_PJ]
        );
      }
    } else {
      // nacin je bank kod (rfb/uni/mf/nlb/uni1) — strukturisan zapis, direktno u tu banku
      // (već je konkretno izabrana ovde).
      await pool.query(
        `INSERT INTO banka_uplate (iznos, banka, izvor, nalog_r_br, kupac_naziv, objekt_naziv, komercijalista_ime, upisao_id, upisao_ime, napomena)
         VALUES ($1,$2,'Proizvodnja',$3,$4,$5,$6,$7,$8,$9)`,
        [iznosNum, nacin, String(nalog.r_br), nalog.narucilac || null, PROIZVODNJA_PJ, nalog.ugovorio || null,
         user.id, user.ime_prezime, `Avans (rata) - nalog #${nalog.r_br}`]
      );
    }

    res.json({ ok: true, avans: noviAvans, avans_opis: noviOpis, za_naplatu: +noviZaNaplatu.toFixed(2), naplaceno: autoNaplaceno });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

// POST /api/proizvodnja/:r_br/naplati-ostatak — ZA RAZLIKU OD avansa (koji je slobodan,
// bilo koji iznos), ovo je STROGO OGRANIČENO na tačan preostali dug — cilj je da se dug
// zatvori na nulu u jednom potezu, uz mogućnost podjele banka+gotovina. Ako je kupac
// platio VIŠE od duga, taj višak se NE knjiži ovdje — ide kroz Avans (odvojeno), kao
// avans za neki budući posao, ne miješa se sa zatvaranjem OVOG duga.
router.post('/:r_br/naplati-ostatak', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const { iznos_banka, nacin_banka, iznos_gotovina, ime_gotovina, licno_preuzeo } = req.body;
  const bankaNum = parseFloat(iznos_banka) || 0;
  const gotovinaNum = parseFloat(iznos_gotovina) || 0;
  if (bankaNum <= 0 && gotovinaNum <= 0)
    return res.status(400).json({ error: 'Unesite bar jedan iznos (banka i/ili gotovina).' });
  if (bankaNum > 0 && !nacin_banka)
    return res.status(400).json({ error: 'Izaberite banku za bankovni dio.' });
  if (gotovinaNum > 0 && !(ime_gotovina || '').trim())
    return res.status(400).json({ error: 'Ime je obavezno za gotovinski dio.' });

  try {
    const nRes = await pool.query(
      'SELECT r_br, narucilac, ugovorio_id, avans, ugovorena_suma, naplaceno_iznos, naplaceno_opis FROM proizvodnja_jopex WHERE r_br=$1',
      [req.params.r_br]
    );
    if (!nRes.rows.length) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    const nalog = nRes.rows[0];

    const isAdmin = user.rola === 'admin';
    const jeSvoj = nalog.ugovorio_id === user.id;
    const smijeFinansije = isAdmin || !!user.moze_ugovarati || jeSvoj;
    if (!smijeFinansije) return res.status(403).json({ error: 'Nemate pravo na finansije ovog naloga.' });

    const zaNaplatuTrenutno = parseFloat(nalog.ugovorena_suma || 0) - parseFloat(nalog.avans || 0) - parseFloat(nalog.naplaceno_iznos || 0);
    const uneseno = bankaNum + gotovinaNum;
    // Tolerancija za zaokruživanje (par para), ne strogo == zbog decimalne aritmetike.
    if (Math.abs(uneseno - zaNaplatuTrenutno) > 0.02)
      return res.status(400).json({
        error: `Zbir (${uneseno.toFixed(2)}) mora tačno pokriti preostali dug (${zaNaplatuTrenutno.toFixed(2)}). Ako je kupac platio više, višak upišite kroz Avans.`,
      });

    const danasKratko = new Date().toLocaleDateString('sr-Latn-BA', { day: '2-digit', month: '2-digit' });
    const noviRedovi = [];
    if (bankaNum > 0) {
      noviRedovi.push(`${nacin_banka} ${danasKratko} - ${bankaNum.toFixed(2)}`);
      // Strukturisan zapis (pored teksta iznad) — banka je VEĆ konkretno izabrana ovde,
      // pa ide DIREKTNO u tu banku (ne u "neraspoređeno").
      await pool.query(
        `INSERT INTO banka_uplate (iznos, banka, izvor, nalog_r_br, kupac_naziv, objekt_naziv, komercijalista_ime, upisao_id, upisao_ime, napomena)
         VALUES ($1,$2,'Proizvodnja',$3,$4,$5,$6,$7,$8,$9)`,
        [bankaNum, nacin_banka, String(nalog.r_br), nalog.narucilac || null, PROIZVODNJA_PJ, nalog.ugovorio || null,
         user.id, user.ime_prezime, `Naplata ostatka - nalog #${nalog.r_br}`]
      );
    }
    if (gotovinaNum > 0) noviRedovi.push(`got ${ime_gotovina.trim()} ${danasKratko} - ${gotovinaNum.toFixed(2)}`);
    // Naplata ostatka ima SVOJ, ODVOJEN log — ne miješa se sa avans_opis (avans je nešto
    // već davno uplaćeno, naplata ostatka je zaseban događaj poslije posla).
    const noviOpis = nalog.naplaceno_opis ? `${nalog.naplaceno_opis}\n${noviRedovi.join('\n')}` : noviRedovi.join('\n');
    const noviNaplacenoIznos = parseFloat(nalog.naplaceno_iznos || 0) + uneseno;

    await pool.query(
      'UPDATE proizvodnja_jopex SET naplaceno_iznos=$1, naplaceno_opis=$2, naplaceno=true WHERE r_br=$3',
      [noviNaplacenoIznos, noviOpis, nalog.r_br]
    );

    if (gotovinaNum > 0) {
      const imeUneseno = ime_gotovina.trim();
      const mojeIme = (user.ime_prezime || '').trim().split(/\s+/)[0].toLowerCase();
      const jeVlastitoIme = imeUneseno.toLowerCase() === mojeIme;
      const jeIOnBlagajnik = await jeBlagajnik(user.id);
      const smijeAutoPredano = jeVlastitoIme && jeIOnBlagajnik;
      const opisGotovine = `Naplata ostatka - nalog #${nalog.r_br}${nalog.narucilac ? ' (' + nalog.narucilac + ')' : ''}`;
      if (smijeAutoPredano) {
        await pool.query(
          `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv,
                                  predao_blagajniku, datum_predaje, preuzeo_ime)
           VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5, true, now(), $2)`,
          [gotovinaNum, imeUneseno, String(nalog.r_br), opisGotovine, PROIZVODNJA_PJ]
        );
      } else {
        await pool.query(
          `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv)
           VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5)`,
          [gotovinaNum, imeUneseno, String(nalog.r_br), opisGotovine, PROIZVODNJA_PJ]
        );
      }
    }

    res.json({ ok: true, naplaceno_iznos: noviNaplacenoIznos, naplaceno_opis: noviOpis, za_naplatu: 0, naplaceno: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

router.patch('/:r_br', async (req, res) => {
  const user = req.session?.user;
  const isAdmin = user?.rola === 'admin';

  const postojeciRes = await pool.query(
    `SELECT ugovorio_id, ugovorio, status, gotovo, reklamacija_dodatni_rad, nova_procjena,
            zadatak, prioritet, narucilac, materijal, pocetak, planirani_zavrsetak,
            napomena, link_skica, link_ponuda,
            ugovorena_suma, avans, naplata_detalji, naplaceno_fakturisano,
            dodatni_rad_napomena, naplaceno
     FROM proizvodnja_jopex WHERE r_br=$1`,
    [req.params.r_br]
  );
  if (!postojeciRes.rows.length) return res.status(404).json({ error: 'Nalog nije pronađen.' });
  const jeSvoj = postojeciRes.rows[0].ugovorio_id === user?.id;
  const staroSvaPolja = postojeciRes.rows[0];

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
  // Kad je nalog VEĆ naplaćen, mijenjanje ugovorene sume/avansa POSLIJE toga nema smisla
  // — naplata je izvršena na osnovu STARIH brojeva, mijenjanje ih sad bi pokvarilo sumu
  // bez logike (izgledalo bi kao da je nešto naplaćeno više/manje nego što stvarno jeste).
  // Admin i dalje SMIJE, za ispravke grešaka — svi ostali su zaključani.
  const vecNaplaceno = staroSvaPolja.naplaceno === true;
  const zakljucanaPoljaZbogNaplate = ['ugovorena_suma', 'avans'];
  const konacnoAllowed = (vecNaplaceno && !isAdmin)
    ? allowed.filter(f => !zakljucanaPoljaZbogNaplate.includes(f))
    : allowed;

  const sets = [], vals = [];
  let i = 1;

  for (const key of konacnoAllowed) {
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
    if (String(staroSvaPolja.ugovorio_id) !== String(req.body.ugovorio_id || null)) {
      await pool.query(
        `INSERT INTO status_promjene_log (r_br, kolona, stara_vrijednost, nova_vrijednost, korisnik_id, korisnik_ime)
         VALUES ($1,'ugovorio',$2,$3,$4,$5)`,
        [req.params.r_br, staroSvaPolja.ugovorio||null, ugovorioIme, user?.id||null, user?.ime_prezime||null]
      );
    }
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

    // Audit trag — beleži SVAKU stvarnu promjenu (ne piše red ako je vrijednost ostala
    // ista), da hover u lista.html može pokazati ko/kad/šta je promijenio (npr.
    // "EH · 04.08.2026 14:23 · Gotovo: Ne → Da"). Pokriva SVA editabilna polja u listi —
    // OSIM avans_opis/naplaceno_opis, koja već imaju SVOJ tekući log (tekst se dopisuje
    // pri svakoj uplati) — dupliranje bi ovde samo pravilo dugačke, nečitljive tekst-diff
    // zapise bez dodatne vrijednosti.
    const SVA_POLJA_ZA_LOG = [
      ...STATUS_POLJA,
      ...OPSTA_POLJA,
      'ugovorena_suma','avans','naplata_detalji','naplaceno_fakturisano','dodatni_rad_napomena','naplaceno',
    ];
    for (const kolona of SVA_POLJA_ZA_LOG) {
      if (kolona in req.body) {
        const staraVr = staroSvaPolja[kolona];
        const novaVr = req.body[kolona];
        // Poredi kao string da se izbjegnu lažne razlike tipa true vs 'true'.
        if (String(staraVr) !== String(novaVr)) {
          await pool.query(
            `INSERT INTO status_promjene_log (r_br, kolona, stara_vrijednost, nova_vrijednost, korisnik_id, korisnik_ime)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [req.params.r_br, kolona, staraVr==null?null:String(staraVr), novaVr==null?null:String(novaVr), user?.id||null, user?.ime_prezime||null]
          );
        }
      }
    }

    if (trebaProvjeruGotovine) {
      // KLJUČNO: "Predano" ide automatski SAMO ako je ulogovana osoba (a) STVARNO
      // registrovan blagajnik I (b) upisala SVOJE vlastito ime u "got X". Ako bilo koji
      // od ova dva uslova ne važi — ostaje "Nije predano" dok se ručno ne potvrdi.
      const mojeIme = (user?.ime_prezime || '').trim().split(/\s+/)[0].toLowerCase();
      const jeIOnBlagajnik = await jeBlagajnik(user?.id);
      const smijeAutoPredano = (val) => jeIOnBlagajnik && izvuciPrimio(val).toLowerCase() === mojeIme;

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
          const opisTekst = `Avans - nalog #${novo.r_br}${novo.narucilac ? ' (' + novo.narucilac + ')' : ''}`;
          if (smijeAutoPredano(novo.avans_opis)) {
            await pool.query(
              `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv,
                                      predao_blagajniku, datum_predaje, preuzeo_ime)
               VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5, true, now(), $6)`,
              [avansIznos, izvuciPrimio(novo.avans_opis), String(novo.r_br), opisTekst, PROIZVODNJA_PJ, user.ime_prezime]
            );
          } else {
            await pool.query(
              `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv)
               VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5)`,
              [avansIznos, izvuciPrimio(novo.avans_opis), String(novo.r_br), opisTekst, PROIZVODNJA_PJ]
            );
          }
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
          const opisTekst = `Naplata - nalog #${novo.r_br}${novo.narucilac ? ' (' + novo.narucilac + ')' : ''}`;
          if (smijeAutoPredano(novo.naplaceno_opis)) {
            await pool.query(
              `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv,
                                      predao_blagajniku, datum_predaje, preuzeo_ime)
               VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5, true, now(), $6)`,
              [zaNaplatu, izvuciPrimio(novo.naplaceno_opis), String(novo.r_br), opisTekst, PROIZVODNJA_PJ, user.ime_prezime]
            );
          } else {
            await pool.query(
              `INSERT INTO gotovina (datum, iznos, primio, izvor, nalog_r_br, opis, objekt_naziv)
               VALUES (CURRENT_DATE, $1, $2, 'Proizvodnja', $3, $4, $5)`,
              [zaNaplatu, izvuciPrimio(novo.naplaceno_opis), String(novo.r_br), opisTekst, PROIZVODNJA_PJ]
            );
          }
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

// PATCH /api/proizvodnja/:r_br/promijeni-broj — SAMO admin. Ručna izmjena broja naloga
// (npr. dupli/pogrešan broj posle uvoza). Osetljivo — r_br je "ime" po kome se nalog
// referencira u gotovini/banci (tekstualno, ne FK), pa se sve mora ažurirati zajedno u
// jednoj transakciji, ili se ništa ne mijenja.
router.patch('/:r_br/promijeni-broj', async (req, res) => {
  const user = req.session?.user;
  if (user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može mijenjati broj naloga.' });
  const stariBr = parseInt(req.params.r_br);
  const noviBr = parseInt(req.body?.novi_r_br);
  if (!noviBr || noviBr <= 0)
    return res.status(400).json({ error: 'Unesite ispravan novi broj.' });
  if (stariBr === noviBr)
    return res.status(400).json({ error: 'Novi broj je isti kao stari.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const postoji = await client.query('SELECT r_br FROM proizvodnja_jopex WHERE r_br=$1', [noviBr]);
    if (postoji.rows.length)
      throw Object.assign(new Error(`Broj ${noviBr} je već zauzet — izaberite drugi.`), { status: 400 });

    const r = await client.query(
      'UPDATE proizvodnja_jopex SET r_br=$1 WHERE r_br=$2 RETURNING r_br, zadatak, narucilac',
      [noviBr, stariBr]
    );
    if (!r.rows.length)
      throw Object.assign(new Error('Nalog nije pronađen.'), { status: 404 });

    // Sve TEKSTUALNE reference (nisu FK, ne ažuriraju se same) — moraju se ručno uskladiti,
    // inače bi te uplate/redovi u blagajni i banci ostali "zalijepljeni" za stari broj.
    await client.query('UPDATE gotovina SET nalog_r_br=$1 WHERE nalog_r_br=$2', [String(noviBr), String(stariBr)]);
    await client.query('UPDATE banka_uplate SET nalog_r_br=$1 WHERE nalog_r_br=$2', [String(noviBr), String(stariBr)]);

    await client.query('COMMIT');
    res.json({ ok: true, stari_broj: stariBr, novi_broj: noviBr, nalog: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ═══ KOMENTARI NA ĆELIJAMA (kao u Excel-u) ═══════════════════════════════ */

// PUT /api/proizvodnja/:r_br/komentar/:kolona — kreira ili ažurira komentar (upsert).
router.put('/:r_br/komentar/:kolona', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const tekst = (req.body?.tekst || '').trim();
  if (!tekst) return res.status(400).json({ error: 'Komentar ne može biti prazan.' });
  try {
    const r = await pool.query(
      `INSERT INTO celija_komentari (r_br, kolona, tekst, autor_id, autor_ime, azurirano)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (r_br, kolona) DO UPDATE SET tekst=$3, autor_id=$4, autor_ime=$5, azurirano=now()
       RETURNING *`,
      [req.params.r_br, req.params.kolona, tekst, user.id, user.ime_prezime]
    );
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/proizvodnja/:r_br/komentar/:kolona
router.delete('/:r_br/komentar/:kolona', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  try {
    await pool.query('DELETE FROM celija_komentari WHERE r_br=$1 AND kolona=$2', [req.params.r_br, req.params.kolona]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/proizvodnja/:r_br/ponuda-json — proxy čitanje JSON-a ponude (sa R2/FTP
// skladišta) PREKO SERVERA, umjesto direktno iz pregledača. Bez ovoga pregledač često
// odbija fetch preko drugog domena (CORS), pa se labele tiho vraćaju na osnovni prikaz
// bez pozicija/mjera, bez ijedne vidljive greške.
router.get('/:r_br/ponuda-json', async (req, res) => {
  try {
    const r = await pool.query('SELECT link_ponuda FROM proizvodnja_jopex WHERE r_br=$1', [req.params.r_br]);
    const link = r.rows[0]?.link_ponuda;
    if (!link) return res.status(404).json({ error: 'Ovaj nalog nema povezanu ponudu.' });
    // Kod uveženih (starih) naloga link_ponuda ponekad NE vodi ka JSON fajlu (npr. stara
    // slika, PDF, ili polomljen link iz uvoza) — provjeri sadržaj PRIJE pokušaja parsiranja
    // kao JSON, da poruka bude jasna umjesto generičkog "Unexpected token '<'".
    const odgovor = await fetch(link);
    if (!odgovor.ok) return res.status(502).json({ error: `Ponuda nije dostupna na skladištu (status ${odgovor.status}). Link: ${link}` });
    const tip = odgovor.headers.get('content-type') || '';
    const tekst = await odgovor.text();
    if (!tip.includes('json') && !tekst.trim().startsWith('{')) {
      // Nije JSON — ALI ako je HTML (npr. ispis naloga), izvuci ČIST TEKST umjesto da
      // jednostavno odustanemo. Bolje nešto korisno na labeli nego prazno "nije podržano".
      if (tip.includes('html')) {
        // Skini <script>/<style> blokove kompletno (njihov sadržaj nije za čitanje), pa
        // sve ostale HTML tagove, pa sažmi višestruke razmake/nove redove u jedan.
        let cistTekst = tekst
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
        // Ograniči dužinu — ovo ide na malu labelu, ne treba cijeli dokument.
        // Labela je FIKSNE, male veličine (100×50mm) — ne sme rasti sa dužinom teksta.
        // 400 znakova je bilo previše (cela stranica ispisa naloga), skraćeno na 70.
        if (cistTekst.length > 70) cistTekst = cistTekst.slice(0, 70) + '…';
        return res.json({ nijeStrukturirano: true, tekst: cistTekst });
      }
      return res.status(422).json({ error: `Link u polju "Link ponuda" ne vodi ka JSON fajlu sa pozicijama — sadržaj je ${tip || 'nepoznatog tipa'}, i nije prepoznat kao tekst koji se može čitati. Link: ${link}` });
    }
    let json;
    try { json = JSON.parse(tekst); }
    catch { return res.status(422).json({ error: `Sadržaj na linku nije ispravan JSON. Link: ${link}` }); }
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: 'Greška pri čitanju ponude: ' + err.message });
  }
});

/* ═══ SLIKE RADNOG NALOGA ═══════════════════════════════════════════════════
   Odvojeno od link_skica (DXF crtež) i link_ponuda (PDF/JSON radnog naloga) — te dvije
   kolone ostaju netaknute i rade kao i dosad. Ovdje idu SAMO fotografije (JPG/PNG), po
   uzoru na roba_slike sistem: više slika po nalogu, jedna glavna, karusel prikaz.
   Razlog: kad mali nalog ima 4 slike, ranije su se pojavljivala 4 linka nabijena u jedno
   tekstualno polje — nepregledno i lako se sudara sa PDF linkom iz velikog naloga. */

// POST /api/proizvodnja/:r_br/slika — dodaje sliku na nalog. Prva ikad dodana postaje glavna.
router.post('/:r_br/slika', uploadSlika.fields([{name:'slika',maxCount:1},{name:'thumb',maxCount:1}]), async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  const glavniFajl = req.files?.slika?.[0];
  const thumbFajl = req.files?.thumb?.[0];
  if (!glavniFajl) return res.status(400).json({ error: 'Nema fajla.' });
  if (!glavniFajl.mimetype.startsWith('image/')) return res.status(400).json({ error: 'Fajl mora biti slika.' });
  try {
    const ekstenzija = (glavniFajl.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const vrijeme = Date.now();
    const url = await uploadFile(`nalog-slike/${req.params.r_br}-${vrijeme}.${ekstenzija}`, glavniFajl.buffer, glavniFajl.mimetype);
    // Mala verzija za prikaz u tabeli (~7x manje podataka nego puna slika).
    let thumbUrl = null;
    if (thumbFajl) {
      thumbUrl = await uploadFile(`nalog-slike/${req.params.r_br}-${vrijeme}-t.jpg`, thumbFajl.buffer, 'image/jpeg');
    }

    const postojeceRes = await pool.query('SELECT COUNT(*) AS n, COALESCE(MAX(redosled),-1) AS max_red FROM nalog_slike WHERE nalog_r_br=$1', [req.params.r_br]);
    const jePrva = parseInt(postojeceRes.rows[0].n) === 0;
    const noviRedosled = parseInt(postojeceRes.rows[0].max_red) + 1;

    const ins = await pool.query(
      'INSERT INTO nalog_slike (nalog_r_br, url, thumb_url, redosled, glavna) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.params.r_br, url, thumbUrl, noviRedosled, jePrva]
    );
    res.json({ ok: true, slika_id: ins.rows[0].id, url, thumb_url: thumbUrl, glavna: jePrva });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri otpremanju slike: ' + err.message });
  }
});

// GET /api/proizvodnja/:r_br/slike — lista svih slika naloga, glavna prva.
router.get('/:r_br/slike', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const r = await pool.query(
      'SELECT id, url, redosled, glavna FROM nalog_slike WHERE nalog_r_br=$1 ORDER BY glavna DESC, redosled ASC',
      [req.params.r_br]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proizvodnja/:r_br/slike/:slikaId/glavna — postavlja jednu kao glavnu.
router.post('/:r_br/slike/:slikaId/glavna', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE nalog_slike SET glavna=false WHERE nalog_r_br=$1', [req.params.r_br]);
    const r = await client.query('UPDATE nalog_slike SET glavna=true WHERE id=$1 AND nalog_r_br=$2 RETURNING id', [req.params.slikaId, req.params.r_br]);
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

// DELETE /api/proizvodnja/:r_br/slike/:slikaId — briše jednu sliku (undo pogrešnog unosa).
router.delete('/:r_br/slike/:slikaId', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const obr = await client.query('DELETE FROM nalog_slike WHERE id=$1 AND nalog_r_br=$2 RETURNING glavna', [req.params.slikaId, req.params.r_br]);
    if (!obr.rows.length) throw Object.assign(new Error('Slika nije pronađena.'), { status: 404 });
    if (obr.rows[0].glavna) {
      const sljedeca = await client.query('SELECT id FROM nalog_slike WHERE nalog_r_br=$1 ORDER BY redosled ASC LIMIT 1', [req.params.r_br]);
      if (sljedeca.rows.length) await client.query('UPDATE nalog_slike SET glavna=true WHERE id=$1', [sljedeca.rows[0].id]);
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

/* ═══ PRETPLATA KUPCA NA RADNOM NALOGU ═══════════════════════════════════════
   Slučaj: kupac plati avans PRIJE nego što nalog uopšte postoji (npr. dogovor za sto koji
   se tek treba ugovoriti). Novac se tada primi kroz Blagajnu → Uplata i stoji kod kupca
   kao PRETPLATA (kupac_transakcije, pozitivan saldo).
   Kad se nalog kasnije formira, ovdje se ta pretplata "prenosi" na nalog: upisuje se u
   polje avans I skida sa salda kupca — inače bi isti novac bio brojan DVAPUT (jednom kao
   pretplata kod kupca, drugi put kao avans na nalogu).
   Nalog nema kupac_id (samo tekst 'narucilac'), pa se kupac traži po imenu. */

// GET /api/proizvodnja/:r_br/pretplata — koliko slobodne pretplate kupac ima
router.get('/:r_br/pretplata', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const n = await pool.query('SELECT narucilac, avans FROM proizvodnja_jopex WHERE r_br=$1', [req.params.r_br]);
    if (!n.rows.length) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    const narucilac = (n.rows[0].narucilac || '').trim();
    if (!narucilac) return res.json({ kupac_id: null, saldo: 0, poruka: 'Nalog nema upisanog naručioca.' });

    // Poklapanje po imenu, bez razlike velika/mala slova i suvišnih razmaka.
    const k = await pool.query(
      `SELECT id, naziv FROM kupci WHERE LOWER(TRIM(naziv)) = LOWER(TRIM($1)) LIMIT 1`,
      [narucilac]
    );
    if (!k.rows.length) return res.json({ kupac_id: null, saldo: 0, poruka: `Kupac "${narucilac}" nije pronađen u šifrarniku kupaca.` });

    const s = await pool.query(
      `SELECT COALESCE(SUM(iznos),0) AS saldo FROM kupac_transakcije WHERE kupac_id=$1`,
      [k.rows[0].id]
    );
    const saldo = +parseFloat(s.rows[0].saldo).toFixed(2);
    res.json({
      kupac_id: k.rows[0].id, kupac_naziv: k.rows[0].naziv,
      saldo, // pozitivan = kupac ima pretplatu; negativan = duguje
      trenutni_avans_naloga: +parseFloat(n.rows[0].avans || 0).toFixed(2),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proizvodnja/:r_br/iskoristi-pretplatu — prenosi pretplatu kupca u avans naloga
router.post('/:r_br/iskoristi-pretplatu', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  const iznos = parseFloat(req.body.iznos);
  if (!iznos || iznos <= 0) return res.status(400).json({ error: 'Unesite ispravan iznos.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const n = await client.query('SELECT narucilac, avans, avans_opis FROM proizvodnja_jopex WHERE r_br=$1 FOR UPDATE', [req.params.r_br]);
    if (!n.rows.length) throw Object.assign(new Error('Nalog nije pronađen.'), { status: 404 });
    const narucilac = (n.rows[0].narucilac || '').trim();

    const k = await client.query(
      `SELECT id, naziv FROM kupci WHERE LOWER(TRIM(naziv)) = LOWER(TRIM($1)) LIMIT 1`, [narucilac]
    );
    if (!k.rows.length) throw Object.assign(new Error(`Kupac "${narucilac}" nije pronađen u šifrarniku.`), { status: 400 });
    const kupacId = k.rows[0].id;

    const s = await client.query('SELECT COALESCE(SUM(iznos),0) AS saldo FROM kupac_transakcije WHERE kupac_id=$1', [kupacId]);
    const saldo = +parseFloat(s.rows[0].saldo).toFixed(2);
    if (iznos > saldo + 0.005)
      throw Object.assign(new Error(`Kupac ima samo ${saldo.toFixed(2)} pretplate, traženo je ${iznos.toFixed(2)}.`), { status: 400 });

    // 1) SKIDA se sa salda kupca — negativan zapis (ista konvencija kao kod otpremnica:
    //    negativan = kredit se troši).
    await client.query(
      `INSERT INTO kupac_transakcije (kupac_id, tip, iznos, opis, komercijalista_id, komercijalista_ime)
       VALUES ($1,'avans_iskoristen',$2,$3,$4,$5)`,
      [kupacId, -iznos, `Prebačeno u avans radnog naloga #${req.params.r_br}`, user.id, user.ime_prezime]
    );

    // 2) DODAJE se na avans naloga (na postojeći, ne zamjenjuje ga).
    const noviAvans = +(parseFloat(n.rows[0].avans || 0) + iznos).toFixed(2);
    const noviOpis = [n.rows[0].avans_opis, `pretplata kupca ${iznos.toFixed(2)}`].filter(Boolean).join(' | ');
    await client.query('UPDATE proizvodnja_jopex SET avans=$1, avans_opis=$2 WHERE r_br=$3',
      [noviAvans, noviOpis, req.params.r_br]);

    // 3) Trag u istoriji naloga (isti mehanizam kao ostale izmjene polja).
    await client.query(
      `INSERT INTO status_promjene_log (r_br, kolona, stara_vrijednost, nova_vrijednost, korisnik_id, korisnik_ime)
       VALUES ($1,'avans',$2,$3,$4,$5)`,
      [req.params.r_br, String(n.rows[0].avans || 0), String(noviAvans), user.id, user.ime_prezime]
    );

    await client.query('COMMIT');
    res.json({ ok: true, novi_avans: noviAvans, preostala_pretplata: +(saldo - iznos).toFixed(2) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
