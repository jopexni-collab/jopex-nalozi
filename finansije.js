// finansije.js — dva nova pod-modula unutar blagajne: Banka i Klijenti finansije
const express = require('express');
const router = express.Router();
const pool = require('./db');

const BANKE = ['rfb', 'uni', 'mf', 'nlb', 'uni1'];

function jeDozvoljeno(user) {
  return !!user && (user.rola === 'admin' || user.je_blagajnik || user.moze_prodavati);
}

// Isti obrazac kao u otpremnice.js — vraća listu ID-jeva PJ na koje je korisnik ograničen,
// ili NULL ako vidi sve (admin, blagajnik za bar jednu PJ, ili nikad eksplicitno ograničen
// prodavac). Koristi se da VP/banka pregled ne pokazuje podatke iz PJ na koje korisnik
// nema nikakvo ovlašćenje (ni blagajnik ni prodavac).
// STRIKTNO ograničenje — kombinuje blagajnici_pj + prodavci_pj (ko god ima ulogu u
// bilo kojoj od te dvije tabele za konkretnu PJ, vidi TU PJ) — BEZ izuzetka "blagajnik
// vidi sve" (za razliku od sličnog helpera u otpremnice.js). Ako korisnik NEMA nijednu
// dodjelu ni u jednoj tabeli, vraća PRAZAN niz (vidi NIŠTA) — ne null (što bi značilo
// "bez ograničenja/vidi sve"). Ograničenje koje je već definisano se poštuje strogo.
async function dozvoljeniPJZaPregled(user) {
  if (!user || user.rola === 'admin') return null;
  const r = await pool.query(
    `SELECT DISTINCT objekat_id FROM blagajnici_pj WHERE zaposleni_id=$1
     UNION
     SELECT DISTINCT objekat_id FROM prodavci_pj WHERE zaposleni_id=$1`,
    [user.id]
  );
  return r.rows.map(row => row.objekat_id); // može biti prazan niz — namjerno, znači "ne vidi nijednu PJ"
}

/* ═══ BANKA ═══════════════════════════════════════════════════════════════ */

// GET /api/finansije/banka — lista bankovnih uplata, sa filterima (banka, od, do,
// neraspoređeno). Bez filtera vraća sve (limit 300, najnovije prvo).
router.get('/banka', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const { banka, od, do: do_, nerasporedjeno, na_cekanju } = req.query;
    const where = [];
    const vals = [];
    let i = 1;
    if (nerasporedjeno === 'true') where.push('banka IS NULL');
    else if (banka) { where.push(`banka = $${i++}`); vals.push(banka); }
    if (na_cekanju === 'true') where.push('potvrdjeno = false');
    if (od) { where.push(`datum >= $${i++}`); vals.push(od); }
    if (do_) { where.push(`datum <= $${i++}`); vals.push(do_); }
    // banka_uplate čuva NAZIV PJ (ne ID) — pretvori dozvoljene ID-jeve u nazive prije
    // filtriranja. Zapisi BEZ objekt_naziv (npr. iz Proizvodnje, nisu vezani za PJ) ostaju
    // vidljivi svima ko ima pristup blagajni — to je "zajednički" novac, ne PJ-specifičan.
    const dozvoljeniPJ = await dozvoljeniPJZaPregled(user);
    if (dozvoljeniPJ) {
      const nazivi = await pool.query('SELECT naziv FROM prodajni_objekti WHERE id = ANY($1::int[])', [dozvoljeniPJ]);
      where.push(`(objekt_naziv = ANY($${i++}::text[]) OR objekt_naziv IS NULL)`);
      vals.push(nazivi.rows.map(r => r.naziv));
    }
    const r = await pool.query(
      `SELECT * FROM banka_uplate ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY datum DESC LIMIT 300`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finansije/banka/:id/potvrdi — admin potvrđuje istorijski unos koji je
// upisao blagajnik (isti duh kao "Predano" dugme za gotovinu).
router.post('/banka/:id/potvrdi', async (req, res) => {
  const user = req.session?.user;
  if (user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin može potvrditi.' });
  try {
    const r = await pool.query(
      `UPDATE banka_uplate SET potvrdjeno=true, potvrdio_id=$1, potvrdio_ime=$2, potvrdjeno_kada=now()
       WHERE id=$3 RETURNING *`,
      [user.id, user.ime_prezime, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/finansije/banka/stanje — zbir po svakoj od 5 banaka + neraspoređeno, za brz
// pregled ("koliko je trenutno u kojoj banci upisano preko sistema"). Broje se SAMO
// potvrđeni zapisi (istorijski unos od blagajnika koji čeka potvrdu se NE broji dok se
// ne potvrdi — isti duh kao "Predano" za gotovinu).
router.get('/banka/stanje', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    // Broje se SAMO potvrđeni I JOŠ NEVERIFIKOVANI (na_izvodu=false) zapisi — čim se
    // neko potvrdi da je vidljivo na stvarnom izvodu, "nestaje" iz ovog zbira (nije više
    // "očekivano", nego je poznato stanje na izvodu, ne treba ga pratiti dvostruko).
    const r = await pool.query(
      `SELECT COALESCE(banka,'nerasporedjeno') AS banka, COALESCE(SUM(iznos),0) AS zbir, COUNT(*) AS broj
       FROM banka_uplate WHERE potvrdjeno=true AND na_izvodu=false GROUP BY banka`
    );
    const naCekanjuRes = await pool.query(`SELECT COUNT(*) AS broj FROM banka_uplate WHERE potvrdjeno=false`);
    const mapa = {};
    BANKE.forEach(b => mapa[b] = { banka: b, zbir: 0, broj: 0 });
    mapa.nerasporedjeno = { banka: 'nerasporedjeno', zbir: 0, broj: 0 };
    r.rows.forEach(row => { mapa[row.banka] = { banka: row.banka, zbir: +row.zbir, broj: +row.broj }; });
    res.json({ banke: Object.values(mapa), na_cekanju: +naCekanjuRes.rows[0].broj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finansije/banka/:id/na-izvodu — čekira/otčekira "verifikovano na bankovnom
// izvodu" (isti duh kao Predano/Nije predano za gotovinu). Ne mijenja iznos ni banku —
// samo status verifikacije.
router.post('/banka/:id/na-izvodu', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  const { na_izvodu } = req.body;
  try {
    const r = await pool.query(
      `UPDATE banka_uplate SET na_izvodu=$1, na_izvodu_ko_id=$2, na_izvodu_ko_ime=$3, na_izvodu_kada=$4
       WHERE id=$5 RETURNING *`,
      [!!na_izvodu, na_izvodu ? user.id : null, na_izvodu ? user.ime_prezime : null, na_izvodu ? new Date() : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/finansije/banka/:id — dodjela neraspoređenog zapisa konkretnoj banci
// (ili promjena banke ako je ranije pogrešno dodijeljena).
router.patch('/banka/:id', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  const { banka } = req.body;
  if (!BANKE.includes(banka)) return res.status(400).json({ error: 'Nepoznata banka.' });
  try {
    const r = await pool.query('UPDATE banka_uplate SET banka=$1 WHERE id=$2 RETURNING *', [banka, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ═══ KLIJENTI FINANSIJE ═════════════════════════════════════════════════ */

// GET /api/finansije/klijenti — po klijentu: koliko duguje (razdvojeno po očekivanom
// načinu naplate — banka/gotovina/nepoznato), plus koliko je DO SAD stvarno uplatio u
// svaku kategoriju. Radi i za registrovane (kupac_id) i za slobodno upisane (samo ime) —
// slobodno upisani se GRUPIŠU po tačnom nazivu (manje pouzdano — otud upozorenje na
// frontend-u da ih treba registrovati).
router.get('/klijenti', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    // Performanse: svih 9 upita ispod su MEĐUSOBNO NEZAVISNI (nijedan ne koristi rezultat
    // prethodnog) — ranije su se izvršavali REDOM (sekvencijalno), sad se šalju ISTOVREMENO
    // (Promise.all) — baza ih obradi paralelno, umjesto da čeka jedan pa drugi pa treći.
    const [
      dugMalo, nijeVerifikovano, dugNalozi, uplatioBanka, pretplate,
      ocekivane, kategorizacija, kategStavkeOtp, kategStavkeNal,
    ] = await Promise.all([
      // Dug iz maloprodaje (otpremnice) — nacin_placanja='banka' se odmah upisuje u
      // banka_uplate (potpuno ili djelimično plaćeno), pa je preostali dug uvijek
      // "nepoznat" način dok se stvarno ne naplati (bira se tek pri samoj naplati).
      pool.query(`
        SELECT
          COALESCE(kupac_id::text, 'ime:'||LOWER(TRIM(kupac_naziv))) AS kljuc,
          kupac_id, kupac_naziv,
          SUM(ukupan_iznos - iznos_placeno) AS iznos
        FROM otpremnice
        WHERE status_placanja != 'placeno' AND status = 'potvrdjena' AND kupac_naziv IS NOT NULL
        GROUP BY kljuc, kupac_id, kupac_naziv
      `),

      // Koliko od tih dugovnih otpremnica JOŠ NIJE pregledao/potvrdio blagajnik ("kontrola")
      // — brojač po klijentu, da "Klijenti finansije" pokaže i ovaj signal (bez otvaranja
      // svake otpremnice pojedinačno).
      pool.query(`
        SELECT
          COALESCE(o.kupac_id::text, 'ime:'||LOWER(TRIM(o.kupac_naziv))) AS kljuc,
          o.kupac_id, o.kupac_naziv, COUNT(*) AS broj
        FROM otpremnice o
        LEFT JOIN gotovina g ON g.nalog_r_br = o.broj AND g.opis LIKE 'Dug po otpremnici%'
        WHERE o.status_placanja != 'placeno' AND o.status = 'potvrdjena' AND o.kupac_naziv IS NOT NULL
          AND (g.predao_blagajniku IS NULL OR g.predao_blagajniku = false)
        GROUP BY kljuc, o.kupac_id, o.kupac_naziv
      `),

      // Dug iz radnih naloga (proizvodnja_jopex) — po naručiocu (slobodan tekst).
      // KRITIČNO: checkbox "Naplaćeno" je ODLUČUJUĆI signal (isti koji koristi i blagajna
      // za "Naplaćeno (nalozi)"/"Očekivano od naloga") — ako je nalog čekiran kao plaćen,
      // NE SMIJE se prikazati kao dug, čak i ako se brojevi (ugovoreno-avans-naplaćeno) ne
      // poklapaju savršeno (npr. zbog podataka iz uvoza koji nisu bili 100% precizni).
      pool.query(`
        SELECT
          'ime:'||LOWER(TRIM(narucilac)) AS kljuc,
          NULL::int AS kupac_id, narucilac AS kupac_naziv,
          SUM(GREATEST(ugovorena_suma - avans - naplaceno_iznos, 0)) AS iznos
        FROM proizvodnja_jopex
        WHERE COALESCE(stornirano,false)=false
          AND COALESCE(naplaceno,false)=false
          AND narucilac IS NOT NULL AND TRIM(narucilac) != ''
          AND (ugovorena_suma - avans - naplaceno_iznos) > 0.01
        GROUP BY kljuc, narucilac
      `),

      // Stvarno uplaćeno u banku (istorijski + iz prodaje) — po klijentu, iz banka_uplate.
      // Samo POTVRĐENI zapisi se broje (istorijski unos od blagajnika čeka potvrdu).
      pool.query(`
        SELECT
          COALESCE(kupac_id::text, 'ime:'||LOWER(TRIM(kupac_naziv))) AS kljuc,
          kupac_id, kupac_naziv, SUM(iznos) AS iznos
        FROM banka_uplate
        WHERE kupac_naziv IS NOT NULL AND potvrdjeno = true
        GROUP BY kljuc, kupac_id, kupac_naziv
      `),

      // Pretplata (avans/kredit) — SAMO za registrovane kupce (kupac_transakcije zahtijeva
      // kupac_id), pozitivan saldo = kupac ima više uplaćeno nego što duguje.
      pool.query(`
        SELECT t.kupac_id, k.naziv AS kupac_naziv, SUM(t.iznos) AS saldo
        FROM kupac_transakcije t JOIN kupci k ON k.id = t.kupac_id
        GROUP BY t.kupac_id, k.naziv
        HAVING SUM(t.iznos) > 0.01
      `),

      // Aktivne (nije realizovano/otkazano) očekivane uplate — SOFT umanjuju prikazani dug
      // (obećanje klijenta, još nije stvarno stiglo na račun).
      pool.query(`
        SELECT
          COALESCE(kupac_id::text, 'ime:'||LOWER(TRIM(kupac_naziv))) AS kljuc,
          kupac_id, kupac_naziv, SUM(iznos) AS iznos
        FROM ocekivane_uplate
        WHERE realizovano=false AND otkazano=false
        GROUP BY kljuc, kupac_id, kupac_naziv
      `),

      // Ručna kategorizacija duga (admin odlučuje šta je "Očekivana naplata" a šta "Teško
      // naplativo" — nezavisno od izvora, može se premeštati u bilo kom trenutku).
      pool.query(`SELECT * FROM dug_kategorizacija`),

      // Kategorizacija PO STAVCI (preciznija, po pojedinačnoj otpremnici/nalogu) — sabira se
      // PO KLIJENTU i dodaje na ručnu (po klijentu) kategorizaciju iznad — oba mehanizma
      // zajedno čine konačan prikaz (po dogovoru, oba ostaju aktivna).
      pool.query(`
        SELECT COALESCE(o.kupac_id::text, 'ime:'||LOWER(TRIM(o.kupac_naziv))) AS kljuc,
               dks.kategorija, SUM(o.ukupan_iznos - o.iznos_placeno) AS iznos
        FROM dug_kategorizacija_stavka dks
        JOIN otpremnice o ON o.id = dks.stavka_id::integer AND dks.tip='otpremnica'
        WHERE o.status_placanja != 'placeno' AND o.status='potvrdjena'
        GROUP BY kljuc, dks.kategorija
      `),
      pool.query(`
        SELECT 'ime:'||LOWER(TRIM(p.narucilac)) AS kljuc,
               dks.kategorija, SUM(GREATEST(p.ugovorena_suma - p.avans - p.naplaceno_iznos, 0)) AS iznos
        FROM dug_kategorizacija_stavka dks
        JOIN proizvodnja_jopex p ON p.r_br = dks.stavka_id::integer AND dks.tip='radni_nalog'
        WHERE COALESCE(p.stornirano,false)=false AND COALESCE(p.naplaceno,false)=false
        GROUP BY kljuc, dks.kategorija
      `),
    ]);

    const kategMapaPoKljucu = {};
    kategorizacija.rows.forEach(k => { kategMapaPoKljucu[k.kljuc] = k; });

    const kategStavkePoKljucu = {}; // kljuc -> {ocekivana_naplata, tesko_naplativo}
    function dodajStavkuKateg(row) {
      if (!kategStavkePoKljucu[row.kljuc]) kategStavkePoKljucu[row.kljuc] = { ocekivana_naplata: 0, tesko_naplativo: 0 };
      kategStavkePoKljucu[row.kljuc][row.kategorija] += parseFloat(row.iznos);
    }
    kategStavkeOtp.rows.forEach(dodajStavkuKateg);
    kategStavkeNal.rows.forEach(dodajStavkuKateg);

    // Sastavi jedinstvenu mapu po klijentu.
    const klijenti = {};
    function osiguraj(kljuc, kupacId, naziv) {
      if (!klijenti[kljuc]) {
        klijenti[kljuc] = {
          kupac_id: kupacId || null, kupac_naziv: naziv,
          registrovan: !!kupacId,
          duguje_banka: 0, duguje_gotovina: 0, duguje_nepoznato: 0,
          uplaceno_banka_istorijski: 0, pretplata: 0, ocekivano: 0, nije_verifikovano_broj: 0,
        };
      }
      return klijenti[kljuc];
    }
    for (const row of dugMalo.rows) {
      const k = osiguraj(row.kljuc, row.kupac_id, row.kupac_naziv);
      k.duguje_nepoznato += +row.iznos;
    }
    for (const row of dugNalozi.rows) {
      const k = osiguraj(row.kljuc, row.kupac_id, row.kupac_naziv);
      k.duguje_nepoznato += +row.iznos;
    }
    for (const row of uplatioBanka.rows) {
      const k = osiguraj(row.kljuc, row.kupac_id, row.kupac_naziv);
      k.uplaceno_banka_istorijski += +row.iznos;
    }
    for (const row of pretplate.rows) {
      const k = osiguraj('' + row.kupac_id, row.kupac_id, row.kupac_naziv);
      k.pretplata = +row.saldo;
    }
    for (const row of ocekivane.rows) {
      const k = osiguraj(row.kljuc, row.kupac_id, row.kupac_naziv);
      k.ocekivano += +row.iznos;
    }
    for (const row of nijeVerifikovano.rows) {
      const k = osiguraj(row.kljuc, row.kupac_id, row.kupac_naziv);
      k.nije_verifikovano_broj = +row.broj;
    }

    const lista = Object.entries(klijenti)
      .map(([kljuc, k]) => {
        const dugujeStvarno = +(k.duguje_banka + k.duguje_gotovina + k.duguje_nepoznato).toFixed(2);
        // "duguje_soft" = dug umanjen za AKTIVNE očekivane uplate (obećanje, još ne
        // stvarno stiglo) — informativno, da tim vidi "šta je stvarno još nerešeno" vs
        // "šta je obećano, čeka se na bankovni izvod".
        const dugujeSoft = +Math.max(0, dugujeStvarno - k.ocekivano).toFixed(2);

        // Ručna kategorizacija — "Očekivana naplata" i "Teško naplativo" su iznosi koje
        // je admin RUČNO premjestio iz podrazumjevanog "Dug" bucket-a. Ne mogu premašiti
        // stvarni ukupan dug (ako se dug u međuvremenu smanjio, kategorizacija se
        // automatski "skalira" da ne pokazuje više nego što stvarno postoji).
        const kateg = kategMapaPoKljucu[kljuc];
        const kategStavke = kategStavkePoKljucu[kljuc] || { ocekivana_naplata: 0, tesko_naplativo: 0 };
        let iznosOcekivanaNaplata = (kateg ? parseFloat(kateg.iznos_ocekivana_naplata) : 0) + kategStavke.ocekivana_naplata;
        let iznosTeskoNaplativo = (kateg ? parseFloat(kateg.iznos_tesko_naplativo) : 0) + kategStavke.tesko_naplativo;
        iznosOcekivanaNaplata = +iznosOcekivanaNaplata.toFixed(2);
        iznosTeskoNaplativo = +iznosTeskoNaplativo.toFixed(2);
        if (iznosOcekivanaNaplata + iznosTeskoNaplativo > dugujeStvarno) {
          const razmjer = dugujeStvarno / (iznosOcekivanaNaplata + iznosTeskoNaplativo);
          iznosOcekivanaNaplata = +(iznosOcekivanaNaplata * razmjer).toFixed(2);
          iznosTeskoNaplativo = +(iznosTeskoNaplativo * razmjer).toFixed(2);
        }
        const iznosDugObican = +Math.max(0, dugujeStvarno - iznosOcekivanaNaplata - iznosTeskoNaplativo).toFixed(2);

        return {
          ...k,
          kljuc,
          duguje_ukupno: dugujeStvarno,
          duguje_soft: dugujeSoft,
          duguje_banka: +k.duguje_banka.toFixed(2),
          duguje_gotovina: +k.duguje_gotovina.toFixed(2),
          duguje_nepoznato: +k.duguje_nepoznato.toFixed(2),
          uplaceno_banka_istorijski: +k.uplaceno_banka_istorijski.toFixed(2),
          pretplata: +k.pretplata.toFixed(2),
          ocekivano: +k.ocekivano.toFixed(2),
          kateg_dug: iznosDugObican,
          kateg_ocekivana_naplata: iznosOcekivanaNaplata,
          kateg_tesko_naplativo: iznosTeskoNaplativo,
          kateg_napomena: kateg?.napomena || null,
        };
      })
      .filter(k => k.duguje_ukupno > 0.01 || k.uplaceno_banka_istorijski > 0.01 || k.pretplata > 0.01)
      .sort((a, b) => b.duguje_ukupno - a.duguje_ukupno);

    res.json(lista);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/finansije/klijent/:id/otpremnice-dug — otpremnice OVOG klijenta koje imaju
// otvoren dug (za dvoklik → biraj koju konkretno naplaćuješ).
router.get('/klijent/:id/otpremnice-dug', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const r = await pool.query(
      `SELECT id, broj, datum, ukupan_iznos, iznos_placeno, (ukupan_iznos-iznos_placeno) AS duguje, objekt_naziv
       FROM otpremnice
       WHERE kupac_id=$1 AND status_placanja != 'placeno' AND status='potvrdjena'
       ORDER BY datum ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finansije/istorijski-unos — ručni unos POČETNOG stanja (novac koji je
// klijent VEĆ platio prije nego što je ovaj sistem postojao). NIJE vezan za konkretnu
// otpremnicu/nalog — samo "on je platio X, vjerujemo mu na riječ". Ako unosi blagajnik
// (ne admin), ide na potvrdu — koristi ISTI mehanizam kao redovna gotovina/banka
// (gotovina.predao_blagajniku / banka_uplate.potvrdjeno).
router.post('/istorijski-unos', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  const { kupac_id, kupac_naziv, tip, banka, iznos, napomena, objekt_id } = req.body;
  const iznosNum = parseFloat(iznos);
  if (!iznosNum || iznosNum <= 0) return res.status(400).json({ error: 'Unesite ispravan iznos.' });
  if (!kupac_id && !kupac_naziv) return res.status(400).json({ error: 'Nedostaje klijent.' });
  const jeAdmin = user.rola === 'admin';
  try {
    let kupacNazivFinal = kupac_naziv || null;
    if (kupac_id && !kupacNazivFinal) {
      const kr = await pool.query('SELECT naziv FROM kupci WHERE id=$1', [kupac_id]);
      kupacNazivFinal = kr.rows[0]?.naziv || null;
    }
    let objektNaziv = null;
    if (objekt_id) {
      const or_ = await pool.query('SELECT naziv FROM prodajni_objekti WHERE id=$1', [objekt_id]);
      objektNaziv = or_.rows[0]?.naziv || null;
    }
    if (tip === 'banka') {
      if (!BANKE.includes(banka)) return res.status(400).json({ error: 'Izaberite banku.' });
      const r = await pool.query(
        `INSERT INTO banka_uplate
           (iznos, banka, izvor, kupac_id, kupac_naziv, objekt_naziv, upisao_id, upisao_ime,
            napomena, potvrdjeno, potvrdio_id, potvrdio_ime, potvrdjeno_kada)
         VALUES ($1,$2,'Istorijski',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [iznosNum, banka, kupac_id || null, kupacNazivFinal, objektNaziv, user.id, user.ime_prezime,
         napomena || 'Istorijski unos', jeAdmin, jeAdmin ? user.id : null, jeAdmin ? user.ime_prezime : null,
         jeAdmin ? new Date() : null]
      );
      return res.json({ ok: true, tip: 'banka', potvrdjeno: jeAdmin, row: r.rows[0] });
    }
    // gotovina — koristi POSTOJEĆI predao_blagajniku mehanizam (ista lista/dugme "Predano"
    // koje već postoji u gotovina.html glavnom tabu).
    const r = await pool.query(
      `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv, predao_blagajniku, datum_predaje, preuzeo_ime)
       VALUES (CURRENT_DATE,$1,$2,'Istorijski',$3,$4,$5,$6,$7) RETURNING *`,
      [iznosNum, user.ime_prezime, `Istorijski unos — ${kupacNazivFinal || 'nepoznat klijent'}${napomena ? ': ' + napomena : ''}`,
       objektNaziv, jeAdmin, jeAdmin ? new Date() : null, jeAdmin ? user.ime_prezime : null]
    );
    res.json({ ok: true, tip: 'gotovina', potvrdjeno: jeAdmin, row: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ═══ OČEKIVANE UPLATE (obećanje klijenta — soft praćenje prije bankovnog izvoda) ══ */

// POST /api/finansije/ocekivana-uplata — blagajnik/admin evidentira da je klijent
// OBEĆAO uplatu (npr. telefonom). NIJE stvarna, potvrđena uplata — vidljivo odvojeno,
// SOFT smanjuje prikazani dug u "Klijenti finansije" dok se stvarno ne potvrdi.
router.post('/ocekivana-uplata', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  const { kupac_id, kupac_naziv, banka, iznos, napomena } = req.body;
  const iznosNum = parseFloat(iznos);
  if (!iznosNum || iznosNum <= 0) return res.status(400).json({ error: 'Unesite ispravan iznos.' });
  if (!kupac_naziv || !kupac_naziv.trim()) return res.status(400).json({ error: 'Nedostaje klijent.' });
  if (!BANKE.includes(banka)) return res.status(400).json({ error: 'Izaberite banku.' });
  try {
    const r = await pool.query(
      `INSERT INTO ocekivane_uplate (kupac_id, kupac_naziv, banka, iznos, napomena, upisao_id, upisao_ime)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [kupac_id || null, kupac_naziv.trim(), banka, iznosNum, napomena || null, user.id, user.ime_prezime]
    );
    res.json({ ok: true, row: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/finansije/ocekivane-uplate?q=pretraga — lista AKTIVNIH (nije realizovano ni
// otkazano) obećanja, sa kvalitetnom pretragom po nazivu klijenta.
router.get('/ocekivane-uplate', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const { q } = req.query;
    const where = ['realizovano = false', 'otkazano = false'];
    const vals = [];
    if (q && q.trim()) { where.push(`kupac_naziv ILIKE $1`); vals.push(`%${q.trim()}%`); }
    const r = await pool.query(
      `SELECT * FROM ocekivane_uplate WHERE ${where.join(' AND ')} ORDER BY kreirano DESC LIMIT 200`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finansije/ocekivana-uplata/:id/realizuj — SAMO ADMIN, "čekira" da se uplata
// STVARNO pojavila na bankovnom izvodu. Ovim se kreira PRAVI (potvrđeni) banka_uplate
// zapis — tek OD SAD se stvarno broji u stanju banke.
router.post('/ocekivana-uplata/:id/realizuj', async (req, res) => {
  const user = req.session?.user;
  if (user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin može potvrditi realizaciju.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM ocekivane_uplate WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!r.rows.length) throw Object.assign(new Error('Nije pronađeno.'), { status: 404 });
    const ou = r.rows[0];
    if (ou.realizovano || ou.otkazano) throw Object.assign(new Error('Ova stavka je već obrađena.'), { status: 400 });

    await client.query(
      `INSERT INTO banka_uplate (iznos, banka, izvor, kupac_id, kupac_naziv, upisao_id, upisao_ime, napomena, potvrdjeno, potvrdio_id, potvrdio_ime, potvrdjeno_kada)
       VALUES ($1,$2,'Ocekivana uplata',$3,$4,$5,$6,$7,true,$8,$9,now())`,
      [ou.iznos, ou.banka, ou.kupac_id, ou.kupac_naziv, ou.upisao_id, ou.upisao_ime,
       `Realizovana očekivana uplata${ou.napomena ? ': ' + ou.napomena : ''}`, user.id, user.ime_prezime]
    );
    await client.query(
      `UPDATE ocekivane_uplate SET realizovano=true, realizovao_id=$1, realizovao_ime=$2, realizovano_kada=now() WHERE id=$3`,
      [user.id, user.ime_prezime, ou.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/finansije/ocekivana-uplata/:id/otkazi — poništava pogrešno unesenu
// očekivanu uplatu (npr. klijent se predomislio, ili greška u unosu).
router.post('/ocekivana-uplata/:id/otkazi', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const r = await pool.query(
      `UPDATE ocekivane_uplate SET otkazano=true WHERE id=$1 AND realizovano=false RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Nije pronađeno ili je već obrađeno.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ═══ VP/BANKA — POTVRDA PO OTPREMNICI (Ideja 2) ══════════════════════════ */
// Umjesto dva odvojena dugmeta (bruto/dug su knjigovodstveno dva reda, ali JEDAN
// stvaran događaj), ovo grupiše sve gotovina redove jedne otpremnice i potvrđuje ih
// SVE odjednom, jednim klikom, na jednom mjestu.

// GET /api/finansije/vp-cekanje — SVE otpremnice koje potiču od VP/dug prodaje (imaju bar
// jedan gotovina red 'Prodaja (bruto)' ili 'Dug po otpremnici'), BEZ obzira da li su već
// potvrđene ili plaćene — otpremnica ostaje vidljiva ovde kao trag, sa statusom koji se
// menja: čeka potvrdu → potvrđeno/nije plaćeno (crveno) → plaćeno.
router.get('/vp-cekanje', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const dozvoljeniPJ = await dozvoljeniPJZaPregled(user);
    // Performanse: CTE agregati (računaju se JEDNOM, iskorišćavaju indekse) umjesto
    // korelisanih podupita po redu (koji bi se ponovo izvršavali za SVAKI red prije
    // ograničavanja/sortiranja) — bitno na skali kad naplate_duga_log poraste.
    const r = await pool.query(`
      WITH vp_bruto AS (
        -- "Prodaja (bruto)" bilježi CIJELU vrijednost prodaje (uključujući dio koji je
        -- ostao kao dug) — VP iznos treba da bude SAMO gotovina koja je STVARNO primljena
        -- u trenutku prodaje, dakle bruto UMANJEN za dug koji je tada nastao. Bez ovoga se
        -- "Struktura naplate" duplirala (VP=cijeli bruto + docnija naplata duga = više od
        -- stvarnog ukupnog iznosa otpremnice).
        -- "dug" je VEĆ upisan kao NEGATIVAN broj u gotovini (konvencija: dug "odlazi" iz
        -- gotovine) — zato se SABIRA (ne oduzima!), sabiranje negativnog broja ispravno
        -- UMANJUJE bruto. Ranije je stajalo "b.bruto - d.dug", što je oduzimanje NEGATIVNOG
        -- broja — to GA DODAJE umjesto oduzima (npr. 11248 - (-3998) = 15246, umjesto
        -- ispravnih 11248 + (-3998) = 7250).
        SELECT b.nalog_r_br, (b.bruto + COALESCE(d.dug,0)) AS vp_iznos
        FROM (SELECT nalog_r_br, SUM(iznos) AS bruto FROM gotovina WHERE opis LIKE 'Prodaja (bruto)%' GROUP BY nalog_r_br) b
        LEFT JOIN (SELECT nalog_r_br, SUM(iznos) AS dug FROM gotovina WHERE opis LIKE 'Dug po otpremnici%' GROUP BY nalog_r_br) d
          ON d.nalog_r_br = b.nalog_r_br
      ),
      naplate_agg AS (
        SELECT otpremnica_broj,
          SUM(iznos) FILTER (WHERE izvor='gotovina') AS naplaceno_gotovina,
          SUM(iznos) FILTER (WHERE izvor='banka') AS naplaceno_banka,
          (array_agg(upisao_ime ORDER BY kreirano DESC))[1] AS naplatio_ime,
          (array_agg(kreirano ORDER BY kreirano DESC))[1] AS naplatio_kada
        FROM naplate_duga_log WHERE COALESCE(stornirano,false)=false
        GROUP BY otpremnica_broj
      )
      SELECT
        o.id, o.broj, o.datum, o.kupac_naziv, o.komercijalista_ime, o.objekt_naziv,
        COALESCE(pj.valuta,'KM') AS valuta,
        o.ukupan_iznos, o.iznos_placeno, o.status_placanja,
        (o.ukupan_iznos - o.iznos_placeno) AS duguje,
        COUNT(g.id) AS broj_zapisa,
        BOOL_AND(g.predao_blagajniku) AS sve_potvrdjeno,
        MAX(g.preuzeo_ime) AS potvrdio_ime,
        na.naplatio_ime, na.naplatio_kada,
        COALESCE(vb.vp_iznos,0) AS vp_iznos,
        COALESCE(na.naplaceno_gotovina,0) AS naplaceno_gotovina,
        COALESCE(na.naplaceno_banka,0) AS naplaceno_banka
      FROM otpremnice o
      JOIN gotovina g ON g.nalog_r_br = o.broj
        AND (g.opis LIKE 'Prodaja (bruto)%' OR g.opis LIKE 'Dug po otpremnici%')
      LEFT JOIN vp_bruto vb ON vb.nalog_r_br = o.broj
      LEFT JOIN naplate_agg na ON na.otpremnica_broj = o.broj
      LEFT JOIN prodajni_objekti pj ON pj.id = o.objekt_id
      ${dozvoljeniPJ ? 'WHERE o.objekt_id = ANY($1::int[])' : ''}
      GROUP BY o.id, o.broj, o.datum, o.kupac_naziv, o.komercijalista_ime, o.objekt_naziv, pj.valuta,
               o.ukupan_iznos, o.iznos_placeno, o.status_placanja,
               na.naplatio_ime, na.naplatio_kada, vb.vp_iznos, na.naplaceno_gotovina, na.naplaceno_banka
      ORDER BY o.datum DESC
      LIMIT 200
    `, dozvoljeniPJ ? [dozvoljeniPJ] : []);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finansije/vp-cekanje/:broj/potvrdi — potvrđuje SVE gotovina redove te
// otpremnice odjednom (bruto i dug, koliko god ih ima) — jedan klik, jedan događaj.
router.post('/vp-cekanje/:broj/potvrdi', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const r = await pool.query(
      `UPDATE gotovina SET predao_blagajniku=true, preuzeo_ime=$1, datum_predaje=now()
       WHERE nalog_r_br=$2 AND (opis LIKE 'Prodaja (bruto)%' OR opis LIKE 'Dug po otpremnici%')
         AND predao_blagajniku=false
       RETURNING id`,
      [user.ime_prezime, req.params.broj]
    );
    res.json({ ok: true, potvrdjeno_zapisa: r.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/finansije/klijent-dug-detalji?kupac_id=X&naziv=Y — SVI izvori duga za jednog
// klijenta (otpremnice maloprodaje + radni nalozi), sa datumom i opisom svake stavke —
// da se klikom na "Duguje" vidi TAČNO odakle dolazi taj iznos.
// POST /api/finansije/kategorizuj-dug — postavlja/premješta iznose između tri kategorije
// duga za jednog klijenta (Dug/Očekivana naplata/Teško naplativo). Šalju se APSOLUTNI
// iznosi za "očekivana naplata" i "tesko naplativo" (ne delta) — "Dug" je uvijek ostatak,
// računa se automatski (nema svoju kolonu u bazi).
router.post('/kategorizuj-dug', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  const { kljuc, kupac_id, kupac_naziv, iznos_ocekivana_naplata, iznos_tesko_naplativo, napomena } = req.body || {};
  if (!kljuc) return res.status(400).json({ error: 'Nedostaje kljuc klijenta.' });
  const ocek = parseFloat(iznos_ocekivana_naplata) || 0;
  const tesko = parseFloat(iznos_tesko_naplativo) || 0;
  if (ocek < 0 || tesko < 0) return res.status(400).json({ error: 'Iznosi ne mogu biti negativni.' });
  try {
    await pool.query(
      `INSERT INTO dug_kategorizacija (kljuc, kupac_id, kupac_naziv, iznos_ocekivana_naplata, iznos_tesko_naplativo, napomena, azurirao_id, azurirao_ime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (kljuc) DO UPDATE SET
         iznos_ocekivana_naplata=$4, iznos_tesko_naplativo=$5, napomena=$6,
         azurirao_id=$7, azurirao_ime=$8, azurirano=now()`,
      [kljuc, kupac_id || null, kupac_naziv || null, ocek, tesko, napomena || null, user.id, user.ime_prezime]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/klijent-dug-detalji', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  const { kupac_id, naziv } = req.query;
  if (!kupac_id && !naziv) return res.status(400).json({ error: 'Nedostaje kupac_id ili naziv.' });
  try {
    const stavke = [];
    // Trenutna kategorizacija po stavci — mapa (tip|stavka_id) -> kategorija, da bi svaka
    // stavka odmah znala u kojoj je "korpi" (za prikaz značke i da dugme zna šta da nudi).
    const kategRes = await pool.query(`SELECT tip, stavka_id, kategorija FROM dug_kategorizacija_stavka`);
    const kategMapa = {};
    kategRes.rows.forEach(k => { kategMapa[k.tip + '|' + k.stavka_id] = k.kategorija; });

    if (kupac_id) {
      const o = await pool.query(
        `SELECT id, broj, datum, ukupan_iznos, iznos_placeno, (ukupan_iznos - iznos_placeno) AS duguje, objekt_naziv
         FROM otpremnice
         WHERE kupac_id=$1 AND status_placanja != 'placeno' AND status='potvrdjena'
         ORDER BY datum ASC`,
        [kupac_id]
      );
      o.rows.forEach(r => stavke.push({
        tip: 'otpremnica', stavka_id: String(r.id), broj: r.broj, datum: r.datum, iznos: +parseFloat(r.duguje).toFixed(2),
        opis: `Maloprodaja — ${r.objekt_naziv || ''} — ukupno ${r.ukupan_iznos}, plaćeno ${r.iznos_placeno}`,
        kategorija: kategMapa['otpremnica|' + r.id] || null,
      }));
    }

    if (naziv) {
      const n = await pool.query(
        `SELECT r_br, pocetak, planirani_zavrsetak, zadatak, ugovorena_suma, avans, naplaceno_iznos,
                (ugovorena_suma - avans - naplaceno_iznos) AS duguje
         FROM proizvodnja_jopex
         WHERE LOWER(TRIM(narucilac))=LOWER(TRIM($1))
           AND COALESCE(stornirano,false)=false AND COALESCE(naplaceno,false)=false
           AND (ugovorena_suma - avans - naplaceno_iznos) > 0.01
         ORDER BY pocetak ASC NULLS LAST`,
        [naziv]
      );
      n.rows.forEach(r => stavke.push({
        tip: 'radni_nalog', stavka_id: String(r.r_br), broj: r.r_br, datum: r.pocetak, iznos: +parseFloat(Math.max(r.duguje,0)).toFixed(2),
        opis: `${r.zadatak || 'Radni nalog'} — ugovoreno ${r.ugovorena_suma}, avans ${r.avans}, naplaćeno ${r.naplaceno_iznos}`,
        kategorija: kategMapa['radni_nalog|' + r.r_br] || null,
      }));
    }

    stavke.sort((a, b) => new Date(a.datum || 0) - new Date(b.datum || 0));
    res.json(stavke);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finansije/stavka-kategorija — postavlja/uklanja kategoriju za JEDNU konkretnu
// stavku (otpremnicu ili radni nalog). kategorija=null uklanja (vraća u običan "Dug").
router.post('/stavka-kategorija', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  const { tip, stavka_id, kategorija, napomena } = req.body || {};
  if (!['otpremnica', 'radni_nalog'].includes(tip)) return res.status(400).json({ error: 'Neispravan tip.' });
  if (!stavka_id) return res.status(400).json({ error: 'Nedostaje stavka_id.' });
  try {
    if (!kategorija) {
      await pool.query(`DELETE FROM dug_kategorizacija_stavka WHERE tip=$1 AND stavka_id=$2`, [tip, String(stavka_id)]);
      return res.json({ ok: true, kategorija: null });
    }
    if (!['ocekivana_naplata', 'tesko_naplativo'].includes(kategorija))
      return res.status(400).json({ error: 'Neispravna kategorija.' });
    await pool.query(
      `INSERT INTO dug_kategorizacija_stavka (tip, stavka_id, kategorija, napomena, azurirao_id, azurirao_ime)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tip, stavka_id) DO UPDATE SET kategorija=$3, napomena=$4, azurirao_id=$5, azurirao_ime=$6, azurirano=now()`,
      [tip, String(stavka_id), kategorija, napomena || null, user.id, user.ime_prezime]
    );
    res.json({ ok: true, kategorija });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/finansije/klijent-uplate-istorija?kupac_id=X&naziv=Y — istorija SVIH stvarnih
// uplata (banka + gotovina) za klijenta, hronološki, da klik na "Uplaćeno" pokaže KADA se
// tačno šta desilo.
router.get('/klijent-uplate-istorija', async (req, res) => {
  const user = req.session?.user;
  if (!jeDozvoljeno(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  const { kupac_id, naziv } = req.query;
  if (!kupac_id && !naziv) return res.status(400).json({ error: 'Nedostaje kupac_id ili naziv.' });
  try {
    const stavke = [];

    const bWhere = [];
    const bVals = [];
    let i = 1;
    if (kupac_id) { bWhere.push(`kupac_id=$${i++}`); bVals.push(kupac_id); }
    if (naziv) { bWhere.push(`LOWER(TRIM(kupac_naziv))=LOWER(TRIM($${i++}))`); bVals.push(naziv); }
    const b = await pool.query(
      `SELECT datum, iznos, banka, izvor, nalog_r_br, napomena, potvrdjeno
       FROM banka_uplate WHERE (${bWhere.join(' OR ')}) ORDER BY datum DESC`,
      bVals
    );
    b.rows.forEach(r => stavke.push({
      tip: 'banka', datum: r.datum, iznos: +parseFloat(r.iznos).toFixed(2),
      opis: `${(r.banka||'Banka').toUpperCase()} — ${r.izvor}${r.nalog_r_br ? ' — nalog/otp ' + r.nalog_r_br : ''}${r.napomena ? ' — ' + r.napomena : ''}`,
      potvrdjeno: r.potvrdjeno,
    }));

    // Gotovina (naplata duga iz radnih naloga — avans/ostatak) povezana preko naziva
    // narucioca kroz sam nalog (gotovina nema kupac_id, ali ima nalog_r_br).
    if (naziv) {
      const g = await pool.query(
        `SELECT g.datum, g.iznos, g.opis, g.nalog_r_br
         FROM gotovina g
         JOIN proizvodnja_jopex p ON p.r_br::text = g.nalog_r_br
         WHERE LOWER(TRIM(p.narucilac))=LOWER(TRIM($1)) AND g.iznos > 0
         ORDER BY g.datum DESC`,
        [naziv]
      );
      g.rows.forEach(r => stavke.push({
        tip: 'gotovina', datum: r.datum, iznos: +parseFloat(r.iznos).toFixed(2),
        opis: `Gotovina — nalog #${r.nalog_r_br} — ${r.opis || ''}`,
      }));
    }

    stavke.sort((a, b) => new Date(b.datum || 0) - new Date(a.datum || 0));
    res.json(stavke);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
