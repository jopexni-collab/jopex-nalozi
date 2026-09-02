const express = require('express');
const router = express.Router();
const pool = require('./db');

// Sve rute ovdje su READ-ONLY (samo SELECT) — analitika ne piše ništa u bazu, bez obzira
// šta se pošalje. Samo prijavljeni korisnici.
router.use((req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
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
    const odMjeseci = Math.min(36, Math.max(1, parseInt(req.query.mjeseci) || 12));
    const objektId = req.query.objekt_id || null;

    const r = await pool.query(
      `SELECT to_char(date_trunc('month', o.datum), 'YYYY-MM')       AS mjesec,
              o.objekt_id,
              o.objekt_naziv,
              COALESCE(NULLIF(TRIM(ro.grupa), ''), 'bez grupe')      AS grupa,
              SUM(s.iznos)                                            AS iznos,
              SUM(s.kolicina)                                         AS kolicina
       FROM otpremnice o
       JOIN otpremnica_stavke s ON s.otpremnica_id = o.id
       LEFT JOIN roba ro ON ro.id = s.roba_id
       WHERE o.status = 'potvrdjena'
         AND o.datum >= date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month'
         ${objektId ? 'AND o.objekt_id = $2' : ''}
       GROUP BY 1, 2, 3, 4
       ORDER BY 1, 3, 4`,
      objektId ? [odMjeseci, objektId] : [odMjeseci]
    );

    /* Proizvodnja se NE moze razbiti po grupama — radni nalog nema stavke po materijalu
       (nalog_stavke je novo i jos prazno za stare naloge). Zato ide kao zaseban zbir
       po mjesecu, da se vidi uz maloprodaju ali se s njom ne mijesa. */
    /* DATUM: koristi se POCETAK (kad je posao stvarno ugovoren), ne datum_kreiranja.
       datum_kreiranja je kad je red upisan u sistem — kad su se stari nalozi unosili
       naknadno, svi bi pali u taj mjesec i pregled bi bio besmislen. */
    const p = await pool.query(
      `SELECT to_char(date_trunc('month', COALESCE(pocetak, datum_kreiranja)), 'YYYY-MM') AS mjesec,
              COUNT(*)::int                            AS naloga,
              SUM(COALESCE(ugovorena_suma, 0))         AS ugovoreno,
              SUM(COALESCE(avans, 0))                  AS naplaceno
       FROM proizvodnja_jopex
       WHERE COALESCE(stornirano, false) = false
         AND COALESCE(pocetak, datum_kreiranja) >= date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month'
       GROUP BY 1 ORDER BY 1`,
      [odMjeseci]
    );

    // Spisak grupa koje se STVARNO pojavljuju — prazne kolone samo smetaju
    const grupe = [...new Set(r.rows.map(x => x.grupa))].sort();

    res.json({
      redovi: r.rows.map(x => ({
        mjesec: x.mjesec,
        objekt_id: x.objekt_id,
        objekt_naziv: x.objekt_naziv,
        grupa: x.grupa,
        iznos: +parseFloat(x.iznos || 0).toFixed(2),
        kolicina: +parseFloat(x.kolicina || 0).toFixed(3),
      })),
      grupe,
      proizvodnja: p.rows.map(x => ({
        mjesec: x.mjesec,
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
