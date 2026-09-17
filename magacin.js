// magacin.js — MAGACINSKI DOKUMENTI (spisak i presjek)
//
// Tabelu `magacin_dokumenti` pune svi moduli: restlovi upisuju izdatnice i povratnice,
// maloprodaja otpremnice, nabavka prijemnice. Ovdje je samo ČITANJE i upis onoga što
// nastaje na ovoj strani.
//
// Sadržaj dokumenta stoji u `stavke` (JSONB) — dokument koji je odštampan i potpisan
// mora sutra izgledati isto. Da se sadržaj računa pri svakom otvaranju, storno jedne
// stavke bi tiho promijenio već potpisan papir.

const express = require('express');
const router = express.Router();
const pool = require('./db');

const VRSTE = ['izdatnica','povratnica','prijemnica','otpremnica','kalkulacija','presjek','usaglasavanje','uvoz'];
const SMJEROVI = ['ulaz','izlaz','ispravka'];

router.use((req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });

/* Zapis u dnevnik. Poziva se pri SVAKOJ promjeni stanja dokumenta — bez toga se ne
   zna ko je sta uradio, ni sta bi vracanje trebalo da vrati. */
async function zapisiLog(izv, dok, radnja, polje, staro, novo, user, napomena) {
  try {
    await izv.query(
      `INSERT INTO magacin_dok_log
         (dokument_id, broj, radnja, polje, staro, novo, napomena, korisnik_id, korisnik_ime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [dok.id, dok.broj, radnja, polje,
       staro == null ? null : String(staro), novo == null ? null : String(novo),
       napomena || null, user?.id || null, user?.ime_prezime || null]
    );
  } catch (e) {
    console.error('magacin_dok_log:', e.message);
  }
}

  next();
});

/* Odobrava ko radi sa lagerom ili sa kupcima — maloprodaja jer troši isti lager,
   ugovaranje jer odgovara za nalog. Bez nove dozvole. */
function smijeOdobriti(u) {
  return u?.rola === 'admin' || u?.moze_ugovarati === true || u?.moze_prodavati === true;
}

function broj(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

/* ── GET /dokumenti — spisak sa filterima ────────────────────────────────────────── */
router.get('/dokumenti', async (req, res) => {
  const uslovi = [];
  const vals = [];
  let i = 1;

  if (VRSTE.includes(req.query.vrsta)) { uslovi.push(`d.vrsta = $${i++}`); vals.push(req.query.vrsta); }
  if (SMJEROVI.includes(req.query.smjer)) { uslovi.push(`d.smjer = $${i++}`); vals.push(req.query.smjer); }
  if (req.query.objekt_id) { uslovi.push(`d.objekt_id = $${i++}`); vals.push(parseInt(req.query.objekt_id)); }
  /* VISE objekata odjednom — cesto se porede dvije PJ. Dokumenti bez objekta ulaze uz
     izabrane, jer se ne zna gdje bi inace pripali, a sakrivanje bi ih izgubilo. */
  if (req.query.objekti) {
    const lista = String(req.query.objekti).split(',').map(x => parseInt(x)).filter(Boolean);
    if (lista.length) {
      uslovi.push(`(d.objekt_id = ANY($${i}::int[]) OR d.objekt_id IS NULL)`);
      vals.push(lista); i++;
    }
  }
  if (req.query.izvor_modul) { uslovi.push(`d.izvor_modul = $${i++}`); vals.push(req.query.izvor_modul); }
  if (req.query.nalog) { uslovi.push(`d.nalog_r_br = $${i++}`); vals.push(parseInt(req.query.nalog)); }
  if (req.query.od) { uslovi.push(`d.izdato >= $${i++}::date`); vals.push(req.query.od); }
  if (req.query.do) { uslovi.push(`d.izdato < ($${i++}::date + interval '1 day')`); vals.push(req.query.do); }
  /* "Nezavrseno" znaci da JOS NESTO treba uraditi — ceka potvrdu ILI ceka knjizenje.
     Ranije je hvatalo samo prvo, pa je spisak bio prazan iako je 71 dokument cekao
     prenos u Bluesoft, a znak ih je urednо brojao. */
  if (req.query.samo_ceka === '1')
    uslovi.push(`(d.odobreno = 'ceka'
                  OR (d.proknjizeno = false AND d.vrsta IN ('otpremnica','prijemnica','kalkulacija')))`);
  if (req.query.samo_otvoreni === '1') uslovi.push(`d.presjek_id IS NULL`);
  if (req.query.q) {
    uslovi.push(`(d.broj ILIKE $${i} OR d.primalac ILIKE $${i} OR d.nalog_r_br::text = $${i + 1})`);
    vals.push(`%${req.query.q}%`, String(req.query.q).trim());
    i += 2;
  }
  /* Stornirani se NE prikazuju podrazumijevano — ostaju u bazi kao trag, ali bi u
     spisku samo smetali. Vide se tek kad se izričito zatraže. */
  if (req.query.sa_storniranim !== '1') uslovi.push(`d.stornirano = false`);

  const gdje = uslovi.length ? `WHERE ${uslovi.join(' AND ')}` : '';
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);

  try {
    const r = await pool.query(
      `SELECT d.*, po.naziv AS objekat_naziv
       FROM magacin_dokumenti d
       LEFT JOIN prodajni_objekti po ON po.id = d.objekt_id
       ${gdje}
       ORDER BY d.izdato DESC NULLS LAST, d.id DESC
       LIMIT ${limit}`,
      vals
    );

    /* Zbirovi se računaju po SMJERU — izlaz i ulaz se ne sabiraju, jer bi zbir bio
       besmislen. Neto je razlika. */
    const izlaz = r.rows.filter(x => x.smjer === 'izlaz');
    const ulaz = r.rows.filter(x => x.smjer === 'ulaz');
    const zbir = a => Math.round(a.reduce((s, x) => s + (Number(x.ukupno_m2) || 0), 0) * 10000) / 10000;

    /* Kad znak kaze da nesto ceka a spisak je prazan, uzrok je skoro uvijek filter —
       ovdje se vraca i sta je primijenjeno, da se to vidi umjesto da se nagadja. */
    res.json({
      stavke: r.rows,
      ukupno: r.rows.length,
      primijenjeni_filteri: uslovi.length ? uslovi : null,
      izlaz_m2: zbir(izlaz),
      ulaz_m2: zbir(ulaz),
      neto_m2: Math.round((zbir(izlaz) - zbir(ulaz)) * 10000) / 10000,
      ceka_odobrenje: r.rows.filter(x => x.odobreno === 'ceka').length,
      smijem_odobriti: smijeOdobriti(req.session.user),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /dokumenti/broj/:broj — jedan dokument ──────────────────────────────────── */
router.get('/dokumenti/broj/:broj', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.*, po.naziv AS objekat_naziv
       FROM magacin_dokumenti d
       LEFT JOIN prodajni_objekti po ON po.id = d.objekt_id
       WHERE d.broj = $1`, [req.params.broj]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Dokument nije pronađen.' });
    res.json({ ...r.rows[0], smijem_odobriti: smijeOdobriti(req.session.user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /dokumenti — upis dokumenta sa OVE strane ──────────────────────────────────
   Koristi se za otpremnice iz maloprodaje i prijemnice od dobavljača. Izdatnice i
   povratnice upisuje modul restlova sam. */
router.post('/dokumenti', async (req, res) => {
  const u = req.session.user;
  const vrsta = req.body?.vrsta;
  if (!['otpremnica', 'prijemnica'].includes(vrsta))
    return res.status(400).json({ error: 'Ovdje se upisuju samo otpremnice i prijemnice.' });

  const stavke = Array.isArray(req.body?.stavke) ? req.body.stavke : null;
  if (!stavke || !stavke.length)
    return res.status(400).json({ error: 'Dokument bez stavki nema smisla.' });

  const smjer = vrsta === 'otpremnica' ? 'izlaz' : 'ulaz';
  const prefiks = vrsta === 'otpremnica' ? 'OTP' : 'PRI';

  try {
    /* Postojeće otpremnice zadržavaju SVOJ broj — inače bi ista isporuka imala dva
       broja, pa se papir i evidencija ne bi mogli spojiti. */
    let brojDok = String(req.body?.broj || '').trim();
    if (!brojDok) {
      const g = new Date().getFullYear();
      const n = await pool.query(
        `SELECT COUNT(*)::int + 1 AS sl FROM magacin_dokumenti
         WHERE vrsta = $1 AND EXTRACT(YEAR FROM COALESCE(izdato, now())) = $2`,
        [vrsta, g]
      );
      brojDok = `${prefiks}-${g}-${String(n.rows[0].sl).padStart(6, '0')}`;
    }

    const ukupnoM2 = stavke.reduce((s, x) => s + broj(x.povrsina), 0);
    const ukupnoKom = stavke.reduce((s, x) => s + (parseInt(x.komada) || 0), 0);
    const vrijednost = stavke.reduce((s, x) => s + broj(x.vrijednost), 0);

    const r = await pool.query(
      `INSERT INTO magacin_dokumenti
         (broj, vrsta, smjer, objekt_id, izvor_modul, nalog_r_br, otpremnica_id,
          primalac, ukupno_m2, ukupno_kom, vrijednost, stavke,
          izdao_ime, izdato, odobreno)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),'ceka')
       RETURNING *`,
      [brojDok, vrsta, smjer,
       parseInt(req.body?.objekt_id) || null,
       vrsta === 'otpremnica' ? 'maloprodaja' : 'nabavka',
       parseInt(req.body?.nalog_r_br) || null,
       parseInt(req.body?.otpremnica_id) || null,
       req.body?.primalac || null,
       ukupnoM2 || null, ukupnoKom || null, vrijednost || null,
       JSON.stringify(stavke), u.ime_prezime]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Dokument sa tim brojem već postoji.' });
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /dokumenti/zbirno — brojke za zaglavlje taba ────────────────────────────── */
router.get('/dokumenti/zbirno', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE odobreno = 'ceka' AND stornirano = false)::int AS ceka,
         COUNT(*) FILTER (WHERE presjek_id IS NULL AND stornirano = false)::int AS otvoreno,
         COUNT(*) FILTER (WHERE izdato::date = CURRENT_DATE AND stornirano = false)::int AS danas,
         COUNT(*) FILTER (WHERE proknjizeno = false
                            AND vrsta IN ('otpremnica','prijemnica','kalkulacija')
                            AND stornirano = false)::int AS za_knjizenje
       FROM magacin_dokumenti`
    );
    res.json({ ...r.rows[0], smijem_odobriti: smijeOdobriti(req.session.user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST /dokumenti/:broj/knjizi — oznaka da je dokument prenesen u Bluesoft.
   NE mijenja lager — samo biljezi da je papir otisao u knjigovodstvo, da se dvaput
   ne prenosi. Knjizi ko ima "Ugovara", isto kao sto i odobrava. */
router.post('/dokumenti/:broj/knjizi', async (req, res) => {
  const u = req.session.user;
  if (!(u?.rola === 'admin' || u?.moze_ugovarati === true))
    return res.status(403).json({ error: 'Knjiženje smije potvrditi samo osoba sa pravom „Ugovara".' });

  try {
    const st = await pool.query('SELECT * FROM magacin_dokumenti WHERE broj=$1', [req.params.broj]);
    if (!st.rows.length) return res.status(404).json({ error: 'Dokument nije pronađen.' });
    const d = st.rows[0];

    if (d.stornirano) return res.status(400).json({ error: 'Storniran dokument se ne knjiži.' });
    if (d.proknjizeno)
      return res.status(400).json({ error: `Već proknjiženo — ${d.proknjizio_ime || ''}.` });

    /* Knjizi se tek POSLIJE potvrde. Neproknjizen a nepotvrdjen dokument znacio bi
       da je u Bluesoft otislo nesto sto niko nije potvrdio da je izdato. */
    if (d.odobreno !== 'odobreno')
      return res.status(400).json({ error: 'Dokument prvo mora biti potvrđen, pa tek onda proknjižen.' });

    const r = await pool.query(
      `UPDATE magacin_dokumenti
       SET proknjizeno=true, proknjizio_id=$1, proknjizio_ime=$2, proknjizeno_kada=now()
       WHERE broj=$3 RETURNING *`,
      [u.id, u.ime_prezime, req.params.broj]
    );
    await zapisiLog(pool, d, 'knjizenje', 'proknjizeno', 'false', 'true', u,
                    req.body?.napomena || 'Preneseno u Bluesoft');
    res.json({ ok: true, dokument: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /dokumenti/:broj/log — istorija izmjena jednog dokumenta */
router.get('/dokumenti/:broj/log', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM magacin_dok_log
       WHERE broj = $1 ORDER BY kada DESC LIMIT 50`, [req.params.broj]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST /dokumenti/:broj/undo/:logId — vracanje jedne izmjene.
   Vraca se SAMO najnovija izmjena tog polja — inace bi se preskocio korak koji je
   neko napravio poslije, a da to niko ne primijeti. */
router.post('/dokumenti/:broj/undo/:logId', async (req, res) => {
  const u = req.session.user;
  if (!(u?.rola === 'admin' || u?.moze_ugovarati === true))
    return res.status(403).json({ error: 'Vraćanje smije samo osoba sa pravom „Ugovara".' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lg = await client.query('SELECT * FROM magacin_dok_log WHERE id=$1', [req.params.logId]);
    if (!lg.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Zapis nije pronađen.' }); }
    const z = lg.rows[0];

    if (z.ponisteno) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Ova izmjena je već vraćena.' }); }

    const zadnji = await client.query(
      `SELECT id FROM magacin_dok_log
       WHERE dokument_id=$1 AND polje=$2 AND ponisteno=false ORDER BY kada DESC LIMIT 1`,
      [z.dokument_id, z.polje]
    );
    if (zadnji.rows[0]?.id !== z.id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Polje „${z.polje}" je poslije toga ponovo mijenjano — vraćanje bi preskočilo taj korak.`,
      });
    }

    /* Vracaju se samo polja stanja. Sadrzaj dokumenta se NE dira — odstampan papir
       mora ostati isti bez obzira na kasnije odluke. */
    const DOZVOLJENA = ['odobreno', 'proknjizeno', 'stornirano'];
    if (!DOZVOLJENA.includes(z.polje)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Polje „${z.polje}" se ne može vratiti.` });
    }

    const v = z.polje === 'odobreno' ? z.staro : z.staro === 'true';
    await client.query(`UPDATE magacin_dokumenti SET ${z.polje} = $1 WHERE id = $2`, [v, z.dokument_id]);

    /* Prateca polja se cisti zajedno — inace bi ostalo ime onoga ko je potvrdio
       dokument koji vise nije potvrdjen. */
    if (z.polje === 'odobreno')
      await client.query(
        `UPDATE magacin_dokumenti SET odobrio_ime=NULL, odobreno_kada=NULL WHERE id=$1`, [z.dokument_id]);
    if (z.polje === 'proknjizeno' && v === false)
      await client.query(
        `UPDATE magacin_dokumenti SET proknjizio_id=NULL, proknjizio_ime=NULL, proknjizeno_kada=NULL WHERE id=$1`,
        [z.dokument_id]);

    await client.query('UPDATE magacin_dok_log SET ponisteno=true WHERE id=$1', [z.id]);
    await client.query(
      `INSERT INTO magacin_dok_log
         (dokument_id, broj, radnja, polje, staro, novo, napomena, korisnik_id, korisnik_ime)
       VALUES ($1,$2,'undo',$3,$4,$5,$6,$7,$8)`,
      [z.dokument_id, z.broj, z.polje, z.novo, z.staro,
       `Vraćena izmjena od ${new Date(z.kada).toLocaleString('sr-Latn-BA')} (${z.korisnik_ime || ''})`,
       u.id, u.ime_prezime]
    );

    await client.query('COMMIT');
    res.json({ ok: true, polje: z.polje, vraceno_na: z.staro });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* POST /dokumenti/grupno — jedna radnja na vise dokumenata odjednom.
   Kod 71 dokumenta koji cekaju knjizenje, jedan po jedan je 71 klik.

   Grupno idu samo POTVRDA i KNJIZENJE. Osporavanje trazi razlog po dokumentu, a
   storno mijenja stanje — ni jedno ni drugo ne smije proci u gomili. */
router.post('/dokumenti/grupno', async (req, res) => {
  const u = req.session.user;
  if (!(u?.rola === 'admin' || u?.moze_ugovarati === true))
    return res.status(403).json({ error: 'Grupnu radnju smije samo osoba sa pravom „Ugovara".' });

  const radnja = req.body?.radnja;
  if (!['knjizenje', 'potvrda'].includes(radnja))
    return res.status(400).json({ error: 'Grupno se mogu samo potvrditi ili proknjižiti.' });

  const brojevi = Array.isArray(req.body?.brojevi) ? req.body.brojevi.map(String) : [];
  if (!brojevi.length) return res.status(400).json({ error: 'Nije izabran nijedan dokument.' });
  if (brojevi.length > 500)
    return res.status(400).json({ error: 'Najviše 500 dokumenata odjednom.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'SELECT * FROM magacin_dokumenti WHERE broj = ANY($1::text[])', [brojevi]);

    const obradjeno = [], preskoceno = [];
    for (const d of r.rows) {
      /* Preskace se umjesto da cijela radnja padne — inace bi jedan vec proknjizen
         dokument srusio ostalih pedeset. */
      if (d.stornirano) { preskoceno.push({ broj: d.broj, razlog: 'stornirano' }); continue; }

      if (radnja === 'potvrda') {
        if (d.odobreno !== 'ceka') { preskoceno.push({ broj: d.broj, razlog: `već ${d.odobreno}` }); continue; }
        await client.query(
          `UPDATE magacin_dokumenti SET odobreno='odobreno', odobrio_ime=$1, odobreno_kada=now()
           WHERE id=$2`, [u.ime_prezime, d.id]);
        await zapisiLog(client, d, 'odobrenje', 'odobreno', d.odobreno, 'odobreno', u, 'Grupna potvrda');
        obradjeno.push(d.broj);

      } else {
        const treba = ['otpremnica', 'prijemnica', 'kalkulacija'].includes(d.vrsta);
        if (!treba) { preskoceno.push({ broj: d.broj, razlog: 'ne prenosi se u Bluesoft' }); continue; }
        if (d.proknjizeno) { preskoceno.push({ broj: d.broj, razlog: 'već proknjiženo' }); continue; }
        if (d.odobreno !== 'odobreno') { preskoceno.push({ broj: d.broj, razlog: 'nije potvrđeno' }); continue; }

        await client.query(
          `UPDATE magacin_dokumenti
           SET proknjizeno=true, proknjizio_id=$1, proknjizio_ime=$2, proknjizeno_kada=now()
           WHERE id=$3`, [u.id, u.ime_prezime, d.id]);
        await zapisiLog(client, d, 'knjizenje', 'proknjizeno', 'false', 'true', u, 'Grupno knjiženje');
        obradjeno.push(d.broj);
      }
    }

    const nenadjeni = brojevi.filter(b => !r.rows.some(x => x.broj === b));
    for (const b of nenadjeni) preskoceno.push({ broj: b, razlog: 'nije pronađen' });

    await client.query('COMMIT');
    res.json({ ok: true, radnja, obradjeno: obradjeno.length, preskoceno });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* ═══ KRETANJE VRIJEDNOSTI LAGERA ══════════════════════════════════════════════════
   Vrijednost lagera raste iz DVA razloga, i moraju se razdvojiti:
     KOLICINA — ima vise robe (prijem, kalkulacija, uvoz)
     CIJENA   — ista roba je skuplja (nivelacija)
   Ako se pomijesaju, izvjestaj ne odgovara ni na jedno pitanje. */
router.get('/kretanje', async (req, res) => {
  const uslovi = [];
  const vals = [];
  let i = 1;

  if (req.query.od) { uslovi.push(`k.datum >= $${i++}::date`); vals.push(req.query.od); }
  if (req.query.do) { uslovi.push(`k.datum < ($${i++}::date + interval '1 day')`); vals.push(req.query.do); }
  if (req.query.tip) { uslovi.push(`k.tip = $${i++}`); vals.push(req.query.tip); }
  if (req.query.ko) { uslovi.push(`k.korisnik_ime = $${i++}`); vals.push(req.query.ko); }
  if (req.query.objekti) {
    const lista = String(req.query.objekti).split(',').map(x => parseInt(x)).filter(Boolean);
    if (lista.length) { uslovi.push(`k.objekt_id = ANY($${i}::int[])`); vals.push(lista); i++; }
  }
  if (req.query.q) {
    uslovi.push(`(r.sifra ILIKE $${i} OR r.naziv ILIKE $${i})`);
    vals.push(`%${req.query.q}%`); i++;
  }

  const gdje = uslovi.length ? `WHERE ${uslovi.join(' AND ')}` : '';
  const limit = Math.min(parseInt(req.query.limit) || 400, 2000);

  try {
    const r = await pool.query(
      `SELECT k.id, k.datum AS kada, k.tip, k.roba_id, k.objekt_id,
              k.kolicina, k.cijena_stara, k.cijena_nova, k.stanje_tada,
              k.napomena, k.korisnik_ime,
              r.sifra, r.naziv, r.grupa, r.jed_mjera,
              po.naziv AS objekat_naziv,
              rp.stanje AS stanje_sada, rp.cijena AS cijena_sada,

              /* Uticaj na VRIJEDNOST lagera, razdvojen po uzroku.
                 Kod nivelacije se uzima stanje U TOM TRENUTKU; ako nije zapisano
                 (stariji zapisi), pada se na danasnje, uz oznaku da je procjena. */
              CASE WHEN k.tip = 'nivelacija'
                   THEN ROUND(((k.cijena_nova - k.cijena_stara)
                        * COALESCE(k.stanje_tada, rp.stanje, 0))::numeric, 2)
                   ELSE 0 END AS uticaj_cijena,

              CASE WHEN k.tip <> 'nivelacija'
                   THEN ROUND((COALESCE(k.kolicina,0)
                        * COALESCE(k.cijena_nova, rp.cijena, 0))::numeric, 2)
                   ELSE 0 END AS uticaj_kolicina,

              (k.tip = 'nivelacija' AND k.stanje_tada IS NULL) AS procjena

       FROM roba_kretanja k
       LEFT JOIN roba r ON r.id = k.roba_id
       LEFT JOIN prodajni_objekti po ON po.id = k.objekt_id
       LEFT JOIN roba_pj rp ON rp.roba_id = k.roba_id AND rp.objekt_id = k.objekt_id
       ${gdje}
       ORDER BY k.datum DESC
       LIMIT ${limit}`,
      vals
    );

    const zbir = (a, k) => Math.round(a.reduce((s, x) => s + (Number(x[k]) || 0), 0) * 100) / 100;
    const niv = r.rows.filter(x => x.tip === 'nivelacija');

    /* Po osobi — ko je koliko pomjerio vrijednost. Razdvojeno, jer nije isto
       dovesti robu i podici cijenu. */
    const poOsobi = {};
    for (const x of r.rows) {
      const ko = x.korisnik_ime || '(nepoznato)';
      if (!poOsobi[ko]) poOsobi[ko] = { ko, nivelacija: 0, kolicina: 0, zapisa: 0, artikala: new Set() };
      poOsobi[ko].nivelacija += Number(x.uticaj_cijena) || 0;
      poOsobi[ko].kolicina += Number(x.uticaj_kolicina) || 0;
      poOsobi[ko].zapisa++;
      if (x.roba_id) poOsobi[ko].artikala.add(x.roba_id);
    }

    res.json({
      stavke: r.rows,
      ukupno: r.rows.length,
      uticaj_cijena: zbir(r.rows, 'uticaj_cijena'),
      uticaj_kolicina: zbir(r.rows, 'uticaj_kolicina'),
      nivelacija_broj: niv.length,
      po_osobi: Object.values(poOsobi)
        .map(o => ({ ...o, artikala: o.artikala.size,
                     nivelacija: Math.round(o.nivelacija * 100) / 100,
                     kolicina: Math.round(o.kolicina * 100) / 100 }))
        .sort((a, b) => Math.abs(b.nivelacija) - Math.abs(a.nivelacija)),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
