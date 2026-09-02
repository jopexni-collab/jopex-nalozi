const express = require('express');
const router = express.Router();
const pool = require('./db');

// Sve rute ovdje su READ-ONLY (samo SELECT) — analitika ne piše ništa u bazu, bez obzira
// šta se pošalje. Samo prijavljeni korisnici.
/* Analitika pokazuje promet SVIH objekata, sve kupce i marže — zato je samo za admina.
   Kartica na pocetnoj se i do sada prikazivala samo adminu, ali server je propustao
   svakog prijavljenog: ko zna adresu, mogao je otvoriti stranicu direktno. */
router.use((req, res, next) => {
  const u = req.session?.user;
  if (!u) return res.status(401).json({ error: 'Niste prijavljeni.' });
  if (u.rola !== 'admin')
    return res.status(403).json({ error: 'Analitika je dostupna samo administratorima.' });
  next();
});

// GET /api/analitika/protok-robe?sifra=X&objekt_id=Y — hronologija JEDNOG artikla: sve
// promjene stanja, bilo odakle dolaze (uvoz/korekcija/storno IZ roba_kretanja, PRODAJA iz
// otpremnica_stavke — prodaja se NE upisuje u roba_kretanja, pa se ovdje ručno spaja).
/* ── GET /api/analitika/mjesecni-po-grupama ────────────────────────────────────────
   Mjesecni pregled prometa PO GRUPAMA materijala. Postojeci "protok robe" trazi jednu
   sifru u jednoj PJ i daje hronoloski spisak — dobar za istragu jednog artikla, ali
   neupotrebljiv za pregled poslovanja.
   Ovdje: redovi = mjesec (+ PJ), kolone = grupe. Racuna se i novac i kolicina, pa se
   u prikazu moze prebacivati bez novog poziva.
   Mjesec ide od PRVOG do ZADNJEG dana, po datumu otpremnice.                        */
router.get('/mjesecni-po-grupama', async (req, res) => {
  try {
    const objektId = req.query.objekt_id || null;

    /* GRANULACIJA — mjesec, kvartal ili godina. Ista tabela, samo se mijenja korak.
       Nazivi kolona se prave u SQL-u da bi sortiranje po tekstu bilo ispravno
       ("2026-Q1" < "2026-Q2" < "2027-Q1"). */
    const gran = ['mjesec', 'kvartal', 'godina'].includes(req.query.granulacija)
      ? req.query.granulacija : 'mjesec';
    const korak = { mjesec: 'month', kvartal: 'quarter', godina: 'year' }[gran];
    const oznaka = {
      mjesec:  `to_char(date_trunc('month', %D), 'YYYY-MM')`,
      kvartal: `to_char(date_trunc('quarter', %D), 'YYYY') || '-Q' || to_char(date_trunc('quarter', %D), 'Q')`,
      godina:  `to_char(date_trunc('year', %D), 'YYYY')`,
    }[gran];

    /* PERIOD — ili izricito od/do, ili zadnjih N koraka. Kad je zadat samo "od",
       "do" je danas; kad je zadat samo "do", uzima se godinu unazad. */
    const od = /^\d{4}-\d{2}-\d{2}$/.test(req.query.od || '') ? req.query.od : null;
    const doD = /^\d{4}-\d{2}-\d{2}$/.test(req.query.do || '') ? req.query.do : null;
    const koliko = Math.min(60, Math.max(1, parseInt(req.query.koliko) || 12));

    const vals = [];
    let uslovO, uslovP;
    if (od || doD) {
      const o = od || '1900-01-01', d = doD || '2999-12-31';
      vals.push(o, d);
      uslovO = `o.datum >= $1::date AND o.datum <= $2::date`;
      uslovP = `COALESCE(p.pocetak, p.datum_kreiranja) >= $1::date
                AND COALESCE(p.pocetak, p.datum_kreiranja) <= $2::date`;
    } else {
      vals.push(koliko);
      uslovO = `o.datum >= date_trunc('${korak}', CURRENT_DATE) - ($1::int - 1) * interval '1 ${korak}'`;
      uslovP = `COALESCE(p.pocetak, p.datum_kreiranja) >= date_trunc('${korak}', CURRENT_DATE) - ($1::int - 1) * interval '1 ${korak}'`;
    }
    const pO = objektId ? (vals.push(objektId), `AND o.objekt_id = $${vals.length}`) : '';

    const r = await pool.query(
      `SELECT ${oznaka.replace(/%D/g, 'o.datum')}                      AS period,
              o.objekt_id, o.objekt_naziv,
              COALESCE(NULLIF(TRIM(ro.grupa), ''), 'bez grupe')        AS grupa,
              s.sifra,
              MIN(s.naziv)                                             AS naziv,
              MIN(ro.jed_mjera)                                        AS jed_mjera,
              /* PREVOD U KM. Iznosi na otpremnici su u valuti SVOG objekta — PJ Niš
                 radi u EUR. Sabirati ih sa KM bez preračuna dalo bi besmislen zbir.
                 Kurs EUR/KM je FIKSAN (1.95583), pa je pretvaranje tačno. */
              SUM(s.iznos * CASE WHEN po.valuta = 'EUR' THEN 1.95583 ELSE 1 END) AS iznos,
              SUM(s.iznos)                                             AS iznos_izvorni,
              MIN(COALESCE(po.valuta, 'KM'))                           AS valuta,
              SUM(s.kolicina)                                          AS kolicina
       FROM otpremnice o
       JOIN otpremnica_stavke s ON s.otpremnica_id = o.id
       LEFT JOIN roba ro ON ro.id = s.roba_id
       LEFT JOIN prodajni_objekti po ON po.id = o.objekt_id
       WHERE o.status = 'potvrdjena' AND ${uslovO} ${pO}
       GROUP BY 1, 2, 3, 4, 5
       ORDER BY 1, 3, 4`,
      vals
    );

    /* Proizvodnja se NE moze razbiti po grupama — radni nalog nema stavke po materijalu.
       Ide kao zaseban red po periodu.
       DATUM: pocetak (kad je posao ugovoren), ne datum_kreiranja — kad su se stari
       nalozi unosili naknadno, svi bi pali u mjesec unosa. */
    const p = await pool.query(
      `SELECT ${oznaka.replace(/%D/g, 'COALESCE(p.pocetak, p.datum_kreiranja)')} AS period,
              COUNT(*)::int                        AS naloga,
              SUM(COALESCE(p.ugovorena_suma, 0))   AS ugovoreno,
              SUM(COALESCE(p.avans, 0))            AS naplaceno
       FROM proizvodnja_jopex p
       WHERE COALESCE(p.stornirano, false) = false AND ${uslovP}
       GROUP BY 1 ORDER BY 1`,
      (od || doD) ? [vals[0], vals[1]] : [koliko]
    );

    res.json({
      granulacija: gran,
      redovi: r.rows.map(x => ({
        mjesec: x.period,
        objekt_id: x.objekt_id,
        objekt_naziv: x.objekt_naziv,
        grupa: x.grupa,
        sifra: x.sifra,
        naziv: x.naziv,
        jed_mjera: x.jed_mjera,
        iznos: +parseFloat(x.iznos || 0).toFixed(2),              // u KM
        iznos_izvorni: +parseFloat(x.iznos_izvorni || 0).toFixed(2),
        valuta: x.valuta || 'KM',
        kolicina: +parseFloat(x.kolicina || 0).toFixed(3),
      })),
      // Da prikaz moze upozoriti kad je bilo preračuna
      ima_eur: r.rows.some(x => x.valuta === 'EUR'),
      /* Kolone se prave iz OBA izvora. Ranije su dolazile samo iz otpremnica, pa su
         mjeseci u kojima je bilo samo proizvodnje (bez prodaje) potpuno ispadali —
         izgledalo je kao da proizvodnja nije razbijena po mjesecima. */
      /* Kolone pokrivaju CIJELI izabrani period, ne samo one u kojima ima podataka.
         Ranije su dolazile samo iz otpremnica, pa su mjeseci sa samo proizvodnjom
         ispadali; a mjesec bez ijednog prometa treba da se VIDI kao prazan, jer i to
         je podatak. */
      mjeseci: (() => {
        const iz = new Set([...r.rows.map(x => x.period), ...p.rows.map(x => x.period)].filter(Boolean));
        const sviU = [...iz].sort();
        if (!sviU.length) return [];
        const prvi = sviU[0], zadnji = sviU[sviU.length - 1];
        const out = [];
        if (gran === 'godina') {
          for (let g = +prvi; g <= +zadnji; g++) out.push(String(g));
        } else if (gran === 'kvartal') {
          let [g, q] = [+prvi.slice(0, 4), +prvi.slice(6)];
          const [gz, qz] = [+zadnji.slice(0, 4), +zadnji.slice(6)];
          while (g < gz || (g === gz && q <= qz)) {
            out.push(`${g}-Q${q}`);
            if (++q > 4) { q = 1; g++; }
          }
        } else {
          let [g, m] = [+prvi.slice(0, 4), +prvi.slice(5)];
          const [gz, mz] = [+zadnji.slice(0, 4), +zadnji.slice(5)];
          while (g < gz || (g === gz && m <= mz)) {
            out.push(`${g}-${String(m).padStart(2, '0')}`);
            if (++m > 12) { m = 1; g++; }
          }
        }
        return out;
      })(),
      grupe: [...new Set(r.rows.map(x => x.grupa))].sort(),
      proizvodnja: p.rows.map(x => ({
        mjesec: x.period,
        naloga: x.naloga,
        ugovoreno: +parseFloat(x.ugovoreno || 0).toFixed(2),
        naplaceno: +parseFloat(x.naplaceno || 0).toFixed(2),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/protok-robe', async (req, res) => {
  try {
    const { sifra, objekt_id } = req.query;
    if (!sifra || !objekt_id) return res.status(400).json({ error: 'Nedostaje šifra ili objekt_id.' });

    const robaRes = await pool.query('SELECT id, naziv, jed_mjera FROM roba WHERE sifra=$1', [sifra]);
    if (!robaRes.rows.length) return res.status(404).json({ error: 'Šifra nije pronađena.' });
    const roba = robaRes.rows[0];

    const ulazi = await pool.query(
      `SELECT datum AS kada, tip, kolicina, napomena, korisnik_ime
       FROM roba_kretanja WHERE roba_id=$1 AND objekt_id=$2
       ORDER BY datum`,
      [roba.id, objekt_id]
    );
    const izlazi = await pool.query(
      `SELECT o.datum AS kada, 'prodaja' AS tip, -s.kolicina AS kolicina,
              ('Prodaja — ' || o.broj || COALESCE(' (' || o.kupac_naziv || ')', '')) AS napomena,
              o.komercijalista_ime AS korisnik_ime
       FROM otpremnica_stavke s
       JOIN otpremnice o ON o.id = s.otpremnica_id
       WHERE s.roba_id=$1 AND o.objekt_id=$2 AND o.status='potvrdjena'
       ORDER BY o.datum`,
      [roba.id, objekt_id]
    );

    const sve = [...ulazi.rows, ...izlazi.rows].sort((a, b) => new Date(a.kada) - new Date(b.kada));
    let tekuce = 0;
    const hronologija = sve.map(red => {
      tekuce += parseFloat(red.kolicina) || 0;
      return { ...red, stanje_poslije: +tekuce.toFixed(3) };
    });

    const trenutnoRes = await pool.query('SELECT stanje, cijena FROM roba_pj WHERE roba_id=$1 AND objekt_id=$2', [roba.id, objekt_id]);
    res.json({
      roba: { sifra, naziv: roba.naziv, jed_mjera: roba.jed_mjera },
      trenutno_stanje: trenutnoRes.rows[0]?.stanje ?? null,
      trenutna_cijena: trenutnoRes.rows[0]?.cijena ?? null,
      hronologija,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analitika/uslo-izaslo?od=X&do=Y&objekt_id=Z — zbirni pregled za period: koliko
// je UŠLO (uvoz + pozitivne korekcije) naspram IZAŠLO (prodaja) — po vrijednosti i broju
// stavki. Ako objekt_id nije poslan, obuhvata SVE PJ.
router.get('/uslo-izaslo', async (req, res) => {
  try {
    const { od, do: doDatuma, objekt_id } = req.query;
    const filterObj = objekt_id ? 'AND objekt_id=$3' : '';
    const filterObjOtp = objekt_id ? 'AND o.objekt_id=$3' : '';
    const vals = od && doDatuma ? [od, doDatuma] : [];
    if (objekt_id) vals.push(objekt_id);
    const filterDatum = od && doDatuma ? 'AND datum::date BETWEEN $1 AND $2' : '';
    const filterDatumOtp = od && doDatuma ? 'AND o.datum::date BETWEEN $1 AND $2' : '';

    const uslo = await pool.query(
      `SELECT COUNT(*) AS broj_dogadjaja, COALESCE(SUM(GREATEST(kolicina,0)),0) AS ukupna_kolicina
       FROM roba_kretanja WHERE kolicina > 0 ${filterDatum} ${filterObj}`,
      vals
    );
    const izaslo = await pool.query(
      `SELECT COUNT(DISTINCT o.id) AS broj_otpremnica, COALESCE(SUM(s.iznos),0) AS ukupna_vrijednost,
              COALESCE(SUM(s.kolicina),0) AS ukupna_kolicina
       FROM otpremnica_stavke s JOIN otpremnice o ON o.id = s.otpremnica_id
       WHERE o.status='potvrdjena' AND s.tip_usluge IS NULL ${filterDatumOtp} ${filterObjOtp}`,
      vals
    );

    res.json({
      uslo: { broj_dogadjaja: +uslo.rows[0].broj_dogadjaja, kolicina: +uslo.rows[0].ukupna_kolicina },
      izaslo: {
        broj_otpremnica: +izaslo.rows[0].broj_otpremnica,
        vrijednost: +izaslo.rows[0].ukupna_vrijednost,
        kolicina: +izaslo.rows[0].ukupna_kolicina,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analitika/top-kupci?od=X&do=Y&objekt_id=Z&limit=20 — najbolji kupci po
// ukupnoj vrijednosti kupovine u periodu (samo potvrđene, ne-stornirane otpremnice).
router.get('/top-kupci', async (req, res) => {
  try {
    const { od, do: doDatuma, objekt_id, limit } = req.query;
    let where = [`o.status='potvrdjena'`, `o.kupac_naziv IS NOT NULL`];
    let vals = [];
    let i = 1;
    if (od && doDatuma) { where.push(`o.datum::date BETWEEN $${i++} AND $${i++}`); vals.push(od, doDatuma); }
    if (objekt_id) { where.push(`o.objekt_id=$${i++}`); vals.push(objekt_id); }
    const r = await pool.query(
      `SELECT o.kupac_naziv, COUNT(*) AS broj_otpremnica, SUM(o.ukupan_iznos) AS ukupno_kupio,
              MAX(o.datum) AS zadnja_kupovina
       FROM otpremnice o
       WHERE ${where.join(' AND ')}
       GROUP BY o.kupac_naziv
       ORDER BY ukupno_kupio DESC
       LIMIT $${i}`,
      [...vals, parseInt(limit) || 20]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analitika/top-prodavano?od=X&do=Y&objekt_id=Z&limit=20 — najprodavaniji artikli
// po vrijednosti (i količini) u periodu.
router.get('/top-prodavano', async (req, res) => {
  try {
    const { od, do: doDatuma, objekt_id, limit } = req.query;
    let where = [`o.status='potvrdjena'`, `s.tip_usluge IS NULL`];
    let vals = [];
    let i = 1;
    if (od && doDatuma) { where.push(`o.datum::date BETWEEN $${i++} AND $${i++}`); vals.push(od, doDatuma); }
    if (objekt_id) { where.push(`o.objekt_id=$${i++}`); vals.push(objekt_id); }
    const r = await pool.query(
      `SELECT s.sifra, s.naziv, SUM(s.kolicina) AS ukupna_kolicina, SUM(s.iznos) AS ukupna_vrijednost,
              COUNT(DISTINCT o.id) AS broj_otpremnica
       FROM otpremnica_stavke s JOIN otpremnice o ON o.id = s.otpremnica_id
       WHERE ${where.join(' AND ')}
       GROUP BY s.sifra, s.naziv
       ORDER BY ukupna_vrijednost DESC
       LIMIT $${i}`,
      [...vals, parseInt(limit) || 20]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analitika/prihod-usluge?od=X&do=Y&objekt_id=Z — prihod GRUPISAN po tipu
// usluge (prevoz/montaža/mjerenje/drugo) — odvojeno od prave robe, da se vidi koliko npr.
// prevoz konkretno donosi.
router.get('/prihod-usluge', async (req, res) => {
  try {
    const { od, do: doDatuma, objekt_id } = req.query;
    let where = [`o.status='potvrdjena'`, `s.tip_usluge IS NOT NULL`];
    let vals = [];
    let i = 1;
    if (od && doDatuma) { where.push(`o.datum::date BETWEEN $${i++} AND $${i++}`); vals.push(od, doDatuma); }
    if (objekt_id) { where.push(`o.objekt_id=$${i++}`); vals.push(objekt_id); }
    const r = await pool.query(
      `SELECT s.tip_usluge, SUM(s.iznos) AS ukupno, COUNT(*) AS broj_stavki
       FROM otpremnica_stavke s JOIN otpremnice o ON o.id = s.otpremnica_id
       WHERE ${where.join(' AND ')}
       GROUP BY s.tip_usluge
       ORDER BY ukupno DESC`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
