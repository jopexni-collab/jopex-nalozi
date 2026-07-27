// finansije.js — dva nova pod-modula unutar blagajne: Banka i Klijenti finansije
const express = require('express');
const router = express.Router();
const pool = require('./db');

const BANKE = ['rfb', 'uni', 'mf', 'nlb', 'uni1'];

function jeDozvoljeno(user) {
  return !!user && (user.rola === 'admin' || user.je_blagajnik || user.moze_prodavati);
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
    const r = await pool.query(
      `SELECT COALESCE(banka,'nerasporedjeno') AS banka, COALESCE(SUM(iznos),0) AS zbir, COUNT(*) AS broj
       FROM banka_uplate WHERE potvrdjeno=true GROUP BY banka`
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
    // Dug iz maloprodaje (otpremnice) — nacin_placanja='banka' se odmah upisuje u
    // banka_uplate (potpuno ili djelimično plaćeno), pa je preostali dug uvijek
    // "nepoznat" način dok se stvarno ne naplati (bira se tek pri samoj naplati).
    const dugMalo = await pool.query(`
      SELECT
        COALESCE(kupac_id::text, 'ime:'||LOWER(TRIM(kupac_naziv))) AS kljuc,
        kupac_id, kupac_naziv,
        SUM(ukupan_iznos - iznos_placeno) AS iznos
      FROM otpremnice
      WHERE status_placanja != 'placeno' AND status = 'potvrdjena' AND kupac_naziv IS NOT NULL
      GROUP BY kljuc, kupac_id, kupac_naziv
    `);

    // Dug iz radnih naloga (proizvodnja_jopex) — po naručiocu (slobodan tekst).
    const dugNalozi = await pool.query(`
      SELECT
        'ime:'||LOWER(TRIM(narucilac)) AS kljuc,
        NULL::int AS kupac_id, narucilac AS kupac_naziv,
        SUM(ugovorena_suma - avans - naplaceno_iznos) AS iznos
      FROM proizvodnja_jopex
      WHERE COALESCE(stornirano,false)=false
        AND narucilac IS NOT NULL AND TRIM(narucilac) != ''
        AND (ugovorena_suma - avans - naplaceno_iznos) > 0.01
      GROUP BY kljuc, narucilac
    `);

    // Stvarno uplaćeno u banku (istorijski + iz prodaje) — po klijentu, iz banka_uplate.
    // Samo POTVRĐENI zapisi se broje (istorijski unos od blagajnika čeka potvrdu).
    const uplatioBanka = await pool.query(`
      SELECT
        COALESCE(kupac_id::text, 'ime:'||LOWER(TRIM(kupac_naziv))) AS kljuc,
        kupac_id, kupac_naziv, SUM(iznos) AS iznos
      FROM banka_uplate
      WHERE kupac_naziv IS NOT NULL AND potvrdjeno = true
      GROUP BY kljuc, kupac_id, kupac_naziv
    `);

    // Pretplata (avans/kredit) — SAMO za registrovane kupce (kupac_transakcije zahtijeva
    // kupac_id), pozitivan saldo = kupac ima više uplaćeno nego što duguje.
    const pretplate = await pool.query(`
      SELECT t.kupac_id, k.naziv AS kupac_naziv, SUM(t.iznos) AS saldo
      FROM kupac_transakcije t JOIN kupci k ON k.id = t.kupac_id
      GROUP BY t.kupac_id, k.naziv
      HAVING SUM(t.iznos) > 0.01
    `);

    // Sastavi jedinstvenu mapu po klijentu.
    const klijenti = {};
    function osiguraj(kljuc, kupacId, naziv) {
      if (!klijenti[kljuc]) {
        klijenti[kljuc] = {
          kupac_id: kupacId || null, kupac_naziv: naziv,
          registrovan: !!kupacId,
          duguje_banka: 0, duguje_gotovina: 0, duguje_nepoznato: 0,
          uplaceno_banka_istorijski: 0, pretplata: 0,
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

    const lista = Object.values(klijenti)
      .map(k => ({
        ...k,
        duguje_ukupno: +(k.duguje_banka + k.duguje_gotovina + k.duguje_nepoznato).toFixed(2),
        duguje_banka: +k.duguje_banka.toFixed(2),
        duguje_gotovina: +k.duguje_gotovina.toFixed(2),
        duguje_nepoznato: +k.duguje_nepoznato.toFixed(2),
        uplaceno_banka_istorijski: +k.uplaceno_banka_istorijski.toFixed(2),
        pretplata: +k.pretplata.toFixed(2),
      }))
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

module.exports = router;
