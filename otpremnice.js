const express = require('express');
const router = express.Router();
const pool = require('./db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { posaljiEmail } = require('./email');

const RAZLOZI = ['kvalitet', 'kolicina', 'lom', 'jedinica', 'drugo'];

// HTML sadržaj emaila za knjigovodstvo — sve što je potrebno da se otpremnica ručno
// unese u Bluesoft: broj, kupac, stavke, iznosi, status plaćanja.
function emailOtpremnicaHtml(otp, stavke) {
  const redovi = stavke.map(s => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${s.sifra}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;">${s.naziv}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;">${s.kolicina} ${s.jed_mjera}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;">${parseFloat(s.cijena).toFixed(2)} KM</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;">${parseFloat(s.iznos).toFixed(2)} KM</td>
    </tr>
  `).join('');
  const statusLabel = { placeno: 'Plaćeno u potpunosti', djelimicno: 'Djelimično plaćeno', duguje: 'Na račun (nije plaćeno)' };
  return `
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#1a2733;max-width:640px;">
      <h2 style="color:#134a85;">Otpremnica ${otp.broj} — za unos u Bluesoft</h2>
      <p><b>Datum:</b> ${new Date(otp.datum).toLocaleString('sr-Latn-BA')}<br>
         <b>Prodajni objekat:</b> ${otp.objekt_naziv || '—'}<br>
         <b>Komercijalista:</b> ${otp.komercijalista_ime || '—'}<br>
         <b>Kupac:</b> ${otp.kupac_naziv || '—'}${otp.kupac_adresa ? ', ' + otp.kupac_adresa : ''}${otp.kupac_telefon ? ' · ' + otp.kupac_telefon : ''}<br>
         <b>Status plaćanja:</b> ${statusLabel[otp.status_placanja] || otp.status_placanja} — plaćeno ${parseFloat(otp.iznos_placeno).toFixed(2)} KM od ${parseFloat(otp.ukupan_iznos).toFixed(2)} KM</p>
      <table style="border-collapse:collapse;width:100%;font-size:12.5px;">
        <thead><tr style="background:#f0f2f5;">
          <th style="padding:4px 8px;text-align:left;">Šifra</th>
          <th style="padding:4px 8px;text-align:left;">Naziv</th>
          <th style="padding:4px 8px;text-align:right;">Količina</th>
          <th style="padding:4px 8px;text-align:right;">Cijena</th>
          <th style="padding:4px 8px;text-align:right;">Iznos</th>
        </tr></thead>
        <tbody>${redovi}</tbody>
      </table>
      <p style="text-align:right;font-size:14px;font-weight:bold;margin-top:8px;">UKUPNO: ${parseFloat(otp.ukupan_iznos).toFixed(2)} KM</p>
      <p style="color:#8b96a5;font-size:11px;margin-top:16px;">Automatska poruka iz JoPeX sistema — otpremnica potvrđena ${new Date(otp.potvrdjeno_vrijeme).toLocaleString('sr-Latn-BA')}.</p>
    </div>
  `;
}

// Pošalje jednu otpremnicu knjigovodstvu (ako PJ ima podešenu email adresu) i upiše
// status. Nikad ne baca grešku — poziva se posle potvrde, ne smije zaustaviti prodaju
// ako email padne.
async function posaljiOtpremnicuKnjigovodstvu(otpId) {
  try {
    const r = await pool.query('SELECT * FROM otpremnice WHERE id=$1', [otpId]);
    if (!r.rows.length) return;
    const otp = r.rows[0];
    const objRes = await pool.query('SELECT email_knjigovodstvo FROM prodajni_objekti WHERE id=$1', [otp.objekt_id]);
    const email = objRes.rows[0]?.email_knjigovodstvo;
    if (!email) return; // PJ nema podešenu adresu — ništa se ne šalje, ništa se ne bilježi kao greška

    const stavkeRes = await pool.query('SELECT * FROM otpremnica_stavke WHERE otpremnica_id=$1', [otpId]);
    const rezultat = await posaljiEmail(email, `Otpremnica ${otp.broj} — ${otp.objekt_naziv}`, emailOtpremnicaHtml(otp, stavkeRes.rows));
    if (rezultat.ok) {
      await pool.query(
        'UPDATE otpremnice SET poslato_knjigovodstvu=true, poslato_knjigovodstvu_vrijeme=now() WHERE id=$1',
        [otpId]
      );
    } else {
      console.error(`Slanje otpremnice ${otp.broj} knjigovodstvu nije uspjelo:`, rezultat.error);
    }
  } catch (err) {
    console.error('Greška u posaljiOtpremnicuKnjigovodstvu:', err.message);
  }
}

// Admin uvijek prolazi; ostali moraju imati moze_prodavati=true (dozvola iz korisnici.html).
router.use((req, res, next) => {
  const u = req.session?.user;
  if (u?.rola === 'admin' || u?.moze_prodavati) return next();
  return res.status(403).json({ error: 'Nemate dozvolu za maloprodaju.' });
});

function trebaObjekat(id) {
  const n = parseInt(id);
  return n > 0 ? n : null;
}

// Generiše broj otpremnice: OTP-YYYY-000123
async function noviBroj(client) {
  const godina = new Date().getFullYear();
  const seq = await client.query("SELECT nextval('otpremnica_broj_seq') AS n");
  const n = String(seq.rows[0].n).padStart(6, '0');
  return `OTP-${godina}-${n}`;
}

// Isti brojač, ali sa DUG- prefiksom — koristi se SAMO za ručno unesene, istorijske
// dugove (bez prave prodaje kroz sistem), da se jasno razlikuju od stvarnih OTP- prodaja
// na svakom pregledu (npr. lista otpremnica, blagajna).
async function noviBrojDug(client) {
  const godina = new Date().getFullYear();
  const seq = await client.query("SELECT nextval('otpremnica_broj_seq') AS n");
  const n = String(seq.rows[0].n).padStart(6, '0');
  return `DUG-${godina}-${n}`;
}

// Učitava trenutne (žive) podatke o robi ZA DATI PRODAJNI OBJEKAT (cijena/stanje su po PJ).
async function ucitajZivuRobu(client, roba_idjevi, objektId) {
  if (!roba_idjevi.length) return {};
  const r = await client.query(
    `SELECT r.id, r.sifra, r.naziv, r.jed_mjera, rp.cijena, rp.stanje
     FROM roba r JOIN roba_pj rp ON rp.roba_id=r.id AND rp.objekt_id=$2
     WHERE r.id = ANY($1::int[])`,
    [roba_idjevi, objektId]
  );
  const map = {};
  for (const row of r.rows) map[row.id] = row;
  return map;
}

// Sastavlja stavke na osnovu ŽIVIH podataka iz baze (cijena_zadana/naziv/stanje UVIJEK iz
// roba+roba_pj ZA IZABRANI PRODAJNI OBJEKAT — svaki PJ ima svoju cijenu i svoje stanje).
// Klijent šalje: roba_id, kolicina, jed_mjera_prodaja (kom/m2/m3 — trgovac SLOBODNO bira, jer
// se šifrarnik pri uvozu samo NAGAĐA), opciono duzina_cm/visina_cm/debljina_cm, i OPCIONO
// override { tip, vrijednost, razlog, napomena } za ručno odstupanje od cijene.
//
// AUTOMATSKO SIGNALIZIRANJE: ako izabrana jedinica NE odgovara jedinici iz šifrarnika, stavka
// se automatski označava kao odstupanje (razlog 'jedinica').
function sastaviStavke(inputStavke, zivaRoba) {
  const DOZVOLJENE_JEDINICE = ['kom', 'm2', 'm3'];
  const stavke = [];
  for (const s of inputStavke) {
    const kolicina = parseFloat(s.kolicina);
    if (!s.roba_id || !kolicina || kolicina <= 0)
      throw Object.assign(new Error('Neispravna stavka u košarici.'), { status: 400 });
    const roba = zivaRoba[s.roba_id];
    if (!roba)
      throw Object.assign(new Error('Artikal nije dostupan (ili nema cijenu/stanje) u ovom prodajnom objektu.'), { status: 400 });
    // NAPOMENA: dozvoljeno je da stanje ode u minus (npr. kamen — prirodan materijal, stvarna
    // količina se često razlikuje od upisane u šifrarniku). Ne blokiramo prodaju, samo
    // BILJEŽIMO da je stanje bilo nedovoljno u tom trenutku — komercijalista i admin to
    // vide kao jasno upozorenje (vidi stanje_nedovoljno/manjak na stavci).
    const raspolozivoPrijeProdaje = parseFloat(roba.stanje);
    const stanjeNedovoljno = raspolozivoPrijeProdaje < kolicina;
    const manjak = stanjeNedovoljno ? +(kolicina - raspolozivoPrijeProdaje).toFixed(3) : 0;

    const jedMjeraProdaja = DOZVOLJENE_JEDINICE.includes(s.jed_mjera_prodaja) ? s.jed_mjera_prodaja : roba.jed_mjera;
    const jedinicaOdstupa = jedMjeraProdaja !== roba.jed_mjera;

    const duzina_cm = s.duzina_cm != null && s.duzina_cm !== '' ? +parseFloat(s.duzina_cm).toFixed(2) : null;
    const visina_cm = s.visina_cm != null && s.visina_cm !== '' ? +parseFloat(s.visina_cm).toFixed(2) : null;
    const debljina_cm = s.debljina_cm != null && s.debljina_cm !== '' ? +parseFloat(s.debljina_cm).toFixed(2) : null;
    const broj_komada = s.broj_komada != null && s.broj_komada !== '' ? Math.max(1, parseInt(s.broj_komada)) : null;

    const cijenaZadana = parseFloat(roba.cijena);
    let cijena = cijenaZadana;
    let razlog = null, napomena = null;

    const ov = s.override;
    if (ov && (ov.tip === 'posto' || ov.tip === 'iznos') && ov.vrijednost !== '' && ov.vrijednost != null) {
      const vrijednost = parseFloat(ov.vrijednost);
      if (isNaN(vrijednost) || vrijednost < 0)
        throw Object.assign(new Error(`Neispravna vrijednost odstupanja za "${roba.naziv}".`), { status: 400 });
      if (!RAZLOZI.includes(ov.razlog))
        throw Object.assign(new Error(`Za odstupanje na "${roba.naziv}" morate izabrati razlog.`), { status: 400 });

      cijena = ov.tip === 'posto'
        ? +(cijenaZadana * (1 - vrijednost / 100)).toFixed(2)
        : +vrijednost.toFixed(2);
      if (cijena < 0) cijena = 0;
      razlog = ov.razlog;
      napomena = (ov.napomena || '').trim().slice(0, 500) || null;
    }

    const cijenaOdstupa = Math.abs(cijena - cijenaZadana) > 0.001;
    const odstupa = cijenaOdstupa || jedinicaOdstupa;
    // Nezavisne oznake (ne gube se čak i ako komercijalista izabere DRUGI razlog uz njih)
    // — koriste se za vizuelno razdvajanje: viša cijena = zeleno, JM promjena = plavo,
    // niža cijena = crveno/narandžasto (ostaje kao upozorenje, to je pravi popust/gubitak).
    const cijenaVisa = cijenaOdstupa && cijena > cijenaZadana;
    const cijenaNiza = cijenaOdstupa && cijena < cijenaZadana;

    let finalRazlog = null, finalNapomena = null;
    if (odstupa) {
      if (jedinicaOdstupa) {
        finalRazlog = razlog || 'jedinica';
        const autoNota = `⚙ Automatski signal: prodano po "${jedMjeraProdaja}" umjesto zadane jedinice "${roba.jed_mjera}" iz šifrarnika — provjeriti cijenu.`;
        finalNapomena = napomena ? `${autoNota} ${napomena}` : autoNota;
      } else {
        finalRazlog = razlog;
        finalNapomena = napomena;
      }
    }

    const iznos = +(kolicina * cijena).toFixed(2);
    stavke.push({
      roba_id: roba.id, sifra: roba.sifra, naziv: roba.naziv, jed_mjera: jedMjeraProdaja,
      kolicina, cijena_zadana: cijenaZadana, cijena, iznos,
      duzina_cm, visina_cm, debljina_cm, broj_komada,
      odstupa, razlog_odstupanja: finalRazlog, napomena_odstupanja: finalNapomena,
      cijena_visa: cijenaVisa, cijena_niza: cijenaNiza, jm_promijenjena: jedinicaOdstupa,
      stanje_nedovoljno: stanjeNedovoljno, manjak, raspolozivo_prije: raspolozivoPrijeProdaje,
    });
  }
  return stavke;
}

// GET /api/otpremnice - lista (komercijalista vidi svoje, admin vidi sve; opciono ?objekt_id=)
router.get('/', async (req, res) => {
  try {
    const user = req.session?.user;
    const { status, od, do: do_, komercijalista_id, odstupanje, objekt_id, broj } = req.query;
    let where = [];
    let vals = [];
    let i = 1;

    // Blagajnik vidi SVE otpremnice za PJ za koji je zadužen (treba mu za dalje
    // knjiženje u Bluesoft) — ne samo one koje je on lično prodao kao komercijalista.
    let blagajnikPJevi = [];
    if (user?.rola !== 'admin') {
      const bp = await pool.query('SELECT objekat_id FROM blagajnici_pj WHERE zaposleni_id=$1', [user.id]);
      blagajnikPJevi = bp.rows.map(r => r.objekat_id);
    }

    // "broj" (deep-link iz blagajne, npr. klik na OTP broj) — admin vidi BILO KOJU
    // otpremnicu po broju, bez obzira ko ju je napravio; ostali vide ako su komercijalista
    // NA TOJ otpremnici ILI blagajnik za taj PJ; ostali ne vide ništa.
    if (broj) {
      where.push(`broj = $${i++}`);
      vals.push(broj);
      if (user?.rola !== 'admin') {
        if (blagajnikPJevi.length) {
          where.push(`(komercijalista_id = $${i++} OR objekt_id = ANY($${i++}::int[]))`);
          vals.push(user.id, blagajnikPJevi);
        } else {
          where.push(`komercijalista_id = $${i++}`); vals.push(user.id);
        }
      }
    } else if (user?.rola !== 'admin') {
      if (blagajnikPJevi.length) {
        where.push(`(komercijalista_id = $${i++} OR objekt_id = ANY($${i++}::int[]))`);
        vals.push(user.id, blagajnikPJevi);
      } else {
        where.push(`komercijalista_id = $${i++}`); vals.push(user.id);
      }
    } else if (komercijalista_id) {
      where.push(`komercijalista_id = $${i++}`);
      vals.push(komercijalista_id);
    }
    if (status) { where.push(`status = $${i++}`); vals.push(status); }
    if (od) { where.push(`datum >= $${i++}`); vals.push(od); }
    if (do_) { where.push(`datum <= $${i++}`); vals.push(do_ + ' 23:59:59'); }
    if (odstupanje === 'true') { where.push(`ima_odstupanje = true`); }
    if (objekt_id) { where.push(`objekt_id = $${i++}`); vals.push(objekt_id); }

    const sql = `SELECT o.*,
      COALESCE(
        (SELECT bool_and(g.predao_blagajniku) FROM gotovina g
         WHERE g.nalog_r_br = o.broj AND g.izvor = 'Maloprodaja'),
        false
      ) AS novac_predat,
      EXISTS(SELECT 1 FROM otpremnica_stavke s WHERE s.otpremnica_id=o.id AND s.cijena_niza) AS ima_cijenu_nizu,
      EXISTS(SELECT 1 FROM otpremnica_stavke s WHERE s.otpremnica_id=o.id AND s.jm_promijenjena AND NOT s.cijena_niza) AS ima_jm_promjenu,
      EXISTS(SELECT 1 FROM otpremnica_stavke s WHERE s.otpremnica_id=o.id AND s.cijena_visa) AS ima_cijenu_visu
      FROM otpremnice o
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY datum DESC LIMIT 300`;
    const r = await pool.query(sql, vals);
    let rows = r.rows;

    // Zaštita od "curenja cijena kroz sjećanje" — obični komercijalista (nije admin/Ponude/
    // blagajnik — blagajniku trebaju puni iznosi za usklađivanje gotovine) vidi pune
    // finansijske podatke SAMO za Danas i Juče. Za sve starije, prikazuje se samo
    // količina/artikal (kao što kupac vidi na svom dokumentu) — bez iznosa. Sprečava da
    // neko kasnije "izrecituje" tačnu staru cijenu nekome van firme.
    const smijePuneFinansije = user?.rola === 'admin' || !!user?.moze_ugovarati || blagajnikPJevi.length > 0;
    if (!smijePuneFinansije) {
      const juce = new Date(); juce.setDate(juce.getDate() - 1); juce.setHours(0, 0, 0, 0);
      rows = rows.map(row => {
        const datumReda = new Date(row.datum);
        if (datumReda >= juce) return row; // Danas/Juče — bez izmjena
        const { ukupan_iznos, iznos_placeno, duguje, ...ostatak } = row;
        return ostatak;
      });
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/pregled - ŽIVI predračun (ne piše ništa u bazu)
// body: { objekt_id, stavke: [{ roba_id, kolicina, override? }] }
router.post('/pregled', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const objektId = trebaObjekat(req.body.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
  const { stavke } = req.body;
  if (!Array.isArray(stavke) || !stavke.length)
    return res.status(400).json({ error: 'Košarica je prazna.' });

  try {
    const idjevi = stavke.map(s => s.roba_id).filter(Boolean);
    const zivaRoba = await ucitajZivuRobu(pool, idjevi, objektId);
    const sastavljene = sastaviStavke(stavke, zivaRoba);
    const ukupanIznos = +sastavljene.reduce((sum, s) => sum + s.iznos, 0).toFixed(2);
    const ukupnoZadano = +sastavljene.reduce((sum, s) => sum + s.kolicina * s.cijena_zadana, 0).toFixed(2);
    const imaOdstupanje = sastavljene.some(s => s.odstupa);
    res.json({
      stavke: sastavljene, ukupan_iznos: ukupanIznos, ukupno_zadano: ukupnoZadano,
      razlika: +(ukupanIznos - ukupnoZadano).toFixed(2), ima_odstupanje: imaOdstupanje,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/otpremnice/:id - zaglavlje + stavke
// GET /api/otpremnice/saldo-po-kupcima?objekt_id=X - lista SVIH kupaca sa saldom != 0
// (pozitivan = avans/zeleno, negativan = duguje/crveno) — za tab "Ne saldirano".
// MORA biti prije "/:id" ispod — inače Express tumači ovo kao vrijednost za :id.
router.get('/saldo-po-kupcima', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT k.id AS kupac_id, k.naziv, k.telefon, k.grad,
              COALESCE(SUM(CASE WHEN p.valuta='EUR' THEN t.iznos*1.95 ELSE t.iznos END),0) AS saldo
       FROM kupac_transakcije t
       JOIN kupci k ON k.id = t.kupac_id
       LEFT JOIN prodajni_objekti p ON p.id = t.objekt_id
       GROUP BY k.id, k.naziv, k.telefon, k.grad
       HAVING COALESCE(SUM(CASE WHEN p.valuta='EUR' THEN t.iznos*1.95 ELSE t.iznos END),0) != 0
       ORDER BY 5 ASC`
    );
    res.json(r.rows.map(row => ({ ...row, saldo: +parseFloat(row.saldo).toFixed(2) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/otpremnice/saldo-kupca/:kupacId - saldo JEDNOG kupca (za blagajnu, kad
// blagajnik naplaćuje — treba brzo da vidi da li kupac duguje, bez povlačenja cijele
// liste svih kupaca). MORA biti prije "/:id" ispod — vidi napomenu gore.
router.get('/saldo-kupca/:kupacId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN p.valuta='EUR' THEN t.iznos*1.95 ELSE t.iznos END),0) AS saldo
       FROM kupac_transakcije t
       LEFT JOIN prodajni_objekti p ON p.id = t.objekt_id
       WHERE t.kupac_id = $1`,
      [req.params.kupacId]
    );
    res.json({ saldo: +parseFloat(r.rows[0]?.saldo || 0).toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ZAKLJUČI DAN ────────────────────────────────────────────────────────────────
// Po OSOBI (komercijalisti) — svako zaključuje svoj dan. Zaključan dan blokira nove
// prodaje (vidi POST /potvrdi) dok se ne otključa (lozinkom).

// GET /api/otpremnice/status-dana?datum=YYYY-MM-DD (opciono, difolt danas)
router.get('/status-dana', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const datum = req.query.datum || new Date().toISOString().split('T')[0];
  try {
    const r = await pool.query(
      'SELECT * FROM dnevno_zakljucanje WHERE zaposleni_id=$1 AND datum=$2',
      [user.id, datum]
    );
    const red = r.rows[0];
    const zakljucano = !!(red && !red.otkljucano_kada);
    res.json({ datum, zakljucano, red: red || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/otpremnice/presjek-dana?datum=YYYY-MM-DD — sažetak za ekran prije zaključenja
// (broj otpremnica/promet, gotovina predano/nepredano, otpremnice poslato/nije poslato).
router.get('/presjek-dana', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const datum = req.query.datum || new Date().toISOString().split('T')[0];
  try {
    const otpRes = await pool.query(
      `SELECT id, broj, ukupan_iznos, objekt_id, poslato_knjigovodstvu
       FROM otpremnice
       WHERE komercijalista_id=$1 AND datum::date=$2 AND status='potvrdjena'`,
      [user.id, datum]
    );
    const brojOtp = otpRes.rows.length;
    const ukupanPromet = otpRes.rows.reduce((s, r) => s + parseFloat(r.ukupan_iznos || 0), 0);
    const nijePoslatoKnjig = otpRes.rows.filter(r => !r.poslato_knjigovodstvu);

    const gotRes = await pool.query(
      `SELECT predao_blagajniku, iznos FROM gotovina
       WHERE primio=$1 AND datum=$2 AND izvor='Maloprodaja'`,
      [user.ime_prezime, datum]
    );
    const gotPredano = gotRes.rows.filter(r => r.predao_blagajniku).reduce((s, r) => s + parseFloat(r.iznos || 0), 0);
    const gotNepredano = gotRes.rows.filter(r => !r.predao_blagajniku).reduce((s, r) => s + parseFloat(r.iznos || 0), 0);

    res.json({
      datum,
      broj_otpremnica: brojOtp,
      ukupan_promet: +ukupanPromet.toFixed(2),
      gotovina_predano: +gotPredano.toFixed(2),
      gotovina_nepredano: +gotNepredano.toFixed(2),
      otpremnice_nije_poslato: nijePoslatoKnjig.map(r => ({ id: r.id, broj: r.broj })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/zakljuci-dan  body: { datum? }
router.post('/zakljuci-dan', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const datum = req.body?.datum || new Date().toISOString().split('T')[0];
  try {
    await pool.query(
      `INSERT INTO dnevno_zakljucanje (zaposleni_id, datum, zakljucao_ime, zakljucano_kada, otkljucano_kada, otkljucao_id, otkljucao_ime)
       VALUES ($1,$2,$3,now(),NULL,NULL,NULL)
       ON CONFLICT (zaposleni_id, datum) DO UPDATE SET
         zakljucao_ime=$3, zakljucano_kada=now(), otkljucano_kada=NULL, otkljucao_id=NULL, otkljucao_ime=NULL`,
      [user.id, datum, user.ime_prezime]
    );
    res.json({ ok: true, datum });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/otkljucaj-dan  body: { datum?, lozinka }
router.post('/otkljucaj-dan', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const datum = req.body?.datum || new Date().toISOString().split('T')[0];
  const { lozinka } = req.body || {};
  if (!lozinka) return res.status(400).json({ error: 'Lozinka je obavezna.' });
  try {
    const uRes = await pool.query('SELECT lozinka FROM zaposleni WHERE id=$1', [user.id]);
    if (!uRes.rows.length) return res.status(404).json({ error: 'Korisnik nije pronađen.' });
    const ok = await bcrypt.compare(lozinka, uRes.rows[0].lozinka || '');
    if (!ok) return res.status(401).json({ error: 'Pogrešna lozinka.' });

    const r = await pool.query(
      `UPDATE dnevno_zakljucanje SET otkljucano_kada=now(), otkljucao_id=$1, otkljucao_ime=$2
       WHERE zaposleni_id=$1 AND datum=$3 AND otkljucano_kada IS NULL RETURNING id`,
      [user.id, user.ime_prezime, datum]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Dan nije zaključan (ili je već otključan).' });
    res.json({ ok: true, datum });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/otpremnice/istorija-zakljucavanja — SAMO admin, pregled ko je i kada
// zaključavao/otključavao dane (za nadzor).
router.get('/istorija-zakljucavanja', async (req, res) => {
  if (req.session?.user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin.' });
  try {
    const r = await pool.query(
      `SELECT dz.*, z.ime_prezime AS zaposleni_ime
       FROM dnevno_zakljucanje dz
       JOIN zaposleni z ON z.id = dz.zaposleni_id
       ORDER BY dz.zakljucano_kada DESC LIMIT 200`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const user = req.session?.user;
    const h = await pool.query('SELECT * FROM otpremnice WHERE id=$1', [req.params.id]);
    if (!h.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    let otp = h.rows[0];
    let jeBlagajnikOvdje = false;
    if (user?.rola !== 'admin' && otp.komercijalista_id !== user.id) {
      const bp = await pool.query(
        'SELECT 1 FROM blagajnici_pj WHERE zaposleni_id=$1 AND objekat_id=$2',
        [user.id, otp.objekt_id]
      );
      if (!bp.rows.length) return res.status(403).json({ error: 'Nema pristupa.' });
      jeBlagajnikOvdje = true;
    }
    const s = await pool.query(
      'SELECT * FROM otpremnica_stavke WHERE otpremnica_id=$1 ORDER BY id', [req.params.id]
    );
    let stavke = s.rows;

    // Ista zaštita kao u listi (vidi GET / gore) — starije od Danas/Juče, obični
    // komercijalista vidi samo količine, ne cijene/iznose (ni na nalogu ni po stavci).
    const smijePuneFinansije = user?.rola === 'admin' || !!user?.moze_ugovarati || jeBlagajnikOvdje;
    if (!smijePuneFinansije) {
      const juce = new Date(); juce.setDate(juce.getDate() - 1); juce.setHours(0, 0, 0, 0);
      if (new Date(otp.datum) < juce) {
        const { ukupan_iznos, iznos_placeno, duguje, ...otpOstatak } = otp;
        otp = otpOstatak;
        stavke = stavke.map(({ cijena, cijena_zadana, iznos, ...stavkaOstatak }) => stavkaOstatak);
      }
    }

    res.json({ ...otp, stavke });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/potvrdi - JEDINI trenutak kad se otpremnica upisuje.
// body: { objekt_id, stavke: [...], kupac_naziv, kupac_adresa, kupac_telefon, kupac_email,
//         kupac_grad, kupac_id, potvrdio_kupac_ime, nacin_placanja, iznos_placeno_sada,
//         nacin_banka (samo za nacin='banka') }
// nacin_placanja: 'kompletno' (cio iznos gotovinom odmah) | 'djelimicno' (gotovina, unosi
// se iznos_placeno_sada) | 'banka' (isto kao djelimicno ali ide na BANKU — bira se koja,
// unosi se iznos_placeno_sada, može biti cio iznos ili djelimično) | 'dug'/VP (ništa se ne
// plaća sad, sve na dug — naplaćuje se kasnije kroz blagajnu, bilo kojim načinom).
router.post('/potvrdi', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const objektId = trebaObjekat(req.body.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });

  // Ako je korisnik zaključao SVOJ dan, ne smije praviti nove prodaje dok se ne otključa.
  const danasDatum = new Date().toISOString().split('T')[0];
  const zakljucanoRes = await pool.query(
    'SELECT id FROM dnevno_zakljucanje WHERE zaposleni_id=$1 AND datum=$2 AND otkljucano_kada IS NULL',
    [user.id, danasDatum]
  );
  if (zakljucanoRes.rows.length)
    return res.status(423).json({ error: 'Zaključao/la si današnji dan. Otključaj (lozinkom) da nastaviš sa prodajom.' });

  const {
    stavke, kupac_naziv, kupac_adresa, kupac_telefon, kupac_email, kupac_grad, kupac_id,
    potvrdio_kupac_ime, nacin_placanja, iznos_placeno_sada, nacin_banka,
  } = req.body;
  if (!Array.isArray(stavke) || !stavke.length)
    return res.status(400).json({ error: 'Košarica je prazna.' });
  if (!potvrdio_kupac_ime || !potvrdio_kupac_ime.trim())
    return res.status(400).json({ error: 'Ime kupca je obavezno za potvrdu.' });
  const nacin = ['kompletno', 'djelimicno', 'banka', 'dug'].includes(nacin_placanja) ? nacin_placanja : 'kompletno';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const objRes = await client.query('SELECT naziv, valuta FROM prodajni_objekti WHERE id=$1 AND aktivan=true', [objektId]);
    if (!objRes.rows.length) throw Object.assign(new Error('Prodajni objekat nije pronađen ili nije aktivan.'), { status: 400 });
    const objektNaziv = objRes.rows[0].naziv;
    const objektValuta = objRes.rows[0].valuta || 'KM';

    const idjevi = stavke.map(s => s.roba_id).filter(Boolean);
    if (idjevi.length) {
      // Zaključaj roba_pj redove za ovaj PJ (ne cijeli roba) da spriječimo trku na stanju.
      await client.query(
        'SELECT id FROM roba_pj WHERE roba_id = ANY($1::int[]) AND objekt_id=$2 FOR UPDATE',
        [idjevi, objektId]
      );
    }
    const zivaRoba = await ucitajZivuRobu(client, idjevi, objektId);
    const sastavljene = sastaviStavke(stavke, zivaRoba);
    const ukupanIznos = +sastavljene.reduce((sum, s) => sum + s.iznos, 0).toFixed(2);
    const imaOdstupanje = sastavljene.some(s => s.odstupa);
    const javniToken = crypto.randomBytes(20).toString('hex');

    // Avans se PRVO primjenjuje na cio iznos (ako je zatraženo) — nezavisno od načina
    // plaćanja, jer inače kod "kompletno" (plaća sve odmah) avans nikad ne bi imao šta
    // da pokrije (iznosPlaceno bi već bio pun ukupanIznos prije nego se avans provjeri).
    // Uzima SAMO avans iz PJ-eva ISTE valute kao ovaj PJ — avans zarađen u EUR ne treba
    // tiho da pokrije kupovinu u KM (i obrnuto) bez jasne, namjerne odluke.
    let iznosIzAvansa = 0;
    if (kupac_id && req.body.koristi_avans) {
      const saldoRes = await client.query(
        `SELECT COALESCE(SUM(t.iznos),0) AS saldo FROM kupac_transakcije t
         LEFT JOIN prodajni_objekti p ON p.id = t.objekt_id
         WHERE t.kupac_id=$1 AND COALESCE(p.valuta,'KM') = $2`,
        [kupac_id, objektValuta]
      );
      const trenutniSaldo = parseFloat(saldoRes.rows[0].saldo);
      if (trenutniSaldo > 0) iznosIzAvansa = +Math.min(trenutniSaldo, ukupanIznos).toFixed(2);
    }
    const preostaloNakonAvansa = +(ukupanIznos - iznosIzAvansa).toFixed(2);

    // Iznos koji se plaća SAD (gotovinom ili bankom, zavisi od "nacin") — odnosi se na
    // ono što je OSTALO nakon avansa, ne na cio ukupanIznos. "banka" i "djelimicno" imaju
    // IDENTIČNU matematiku — razlikuju se SAMO gdje se novac na kraju upisuje.
    let iznosSada;
    if (nacin === 'kompletno') iznosSada = preostaloNakonAvansa;
    else if (nacin === 'dug') iznosSada = 0;
    else { // djelimicno ILI banka
      iznosSada = parseFloat(iznos_placeno_sada);
      if (isNaN(iznosSada) || iznosSada <= 0)
        throw Object.assign(new Error('Unesite ispravan iznos koji kupac plaća sada.'), { status: 400 });
      if (iznosSada > preostaloNakonAvansa)
        throw Object.assign(new Error('Iznos koji kupac plaća sada ne može biti veći od preostalog iznosa (nakon avansa).'), { status: 400 });
    }
    iznosSada = +iznosSada.toFixed(2);
    if (nacin === 'banka' && !nacin_banka)
      throw Object.assign(new Error('Izaberite banku.'), { status: 400 });
    let iznosPlaceno = +(iznosIzAvansa + iznosSada).toFixed(2);
    const statusPlacanja = iznosPlaceno >= ukupanIznos ? 'placeno' : (iznosPlaceno > 0 ? 'djelimicno' : 'duguje');

    const broj = await noviBroj(client);
    const h = await client.query(
      `INSERT INTO otpremnice
         (broj, komercijalista_id, komercijalista_ime, objekt_id, objekt_naziv,
          kupac_id, kupac_naziv, kupac_adresa, kupac_telefon, kupac_email, kupac_grad,
          javni_token, ukupan_iznos, status, ima_odstupanje, potvrdio_kupac_ime, potvrdjeno_vrijeme,
          iznos_placeno, status_placanja)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'potvrdjena',$14,$15, now(), $16,$17) RETURNING *`,
      [broj, user.id, user.ime_prezime, objektId, objektNaziv,
       kupac_id || null, kupac_naziv || null, kupac_adresa || null,
       kupac_telefon || null, kupac_email || null, kupac_grad || null, javniToken, ukupanIznos,
       imaOdstupanje, potvrdio_kupac_ime.trim(), iznosPlaceno, statusPlacanja]
    );
    const otpId = h.rows[0].id;

    for (const s of sastavljene) {
      await client.query(
        `INSERT INTO otpremnica_stavke
           (otpremnica_id, roba_id, sifra, naziv, jed_mjera, kolicina,
            cijena_zadana, cijena, iznos, razlog_odstupanja, napomena_odstupanja,
            duzina_cm, visina_cm, debljina_cm, broj_komada,
            cijena_visa, cijena_niza, jm_promijenjena, stanje_nedovoljno, manjak)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [otpId, s.roba_id, s.sifra, s.naziv, s.jed_mjera, s.kolicina,
         s.cijena_zadana, s.cijena, s.iznos, s.razlog_odstupanja, s.napomena_odstupanja,
         s.duzina_cm, s.visina_cm, s.debljina_cm, s.broj_komada,
         s.cijena_visa, s.cijena_niza, s.jm_promijenjena, s.stanje_nedovoljno, s.manjak]
      );
      // Stanje se smanjuje SAMO za ovaj prodajni objekat (roba_pj), ne globalno.
      // Napomena: roba IZLAZI iz magacina bez obzira na način plaćanja (i kad je na dug) —
      // to se ovdje namjerno ne mijenja, dug je isključivo pitanje novca, ne robe.
      await client.query(
        'UPDATE roba_pj SET stanje = stanje - $1, azurirano = now() WHERE roba_id=$2 AND objekt_id=$3',
        [s.kolicina, s.roba_id, objektId]
      );
    }

    const opisKupca = kupac_naziv ? kupac_naziv.trim() : 'kupac nepoznat';
    const preostaliDug = +(ukupanIznos - iznosPlaceno).toFixed(2);
    // Bruto vrijednost prodaje umanjena za avans (avans je već upisan u blagajnu kad je
    // prvobitno uplaćen — ne broji se ponovo ovdje).
    const brutoZaBlagajnu = +(ukupanIznos - iznosIzAvansa).toFixed(2);
    const jeBanka = nacin === 'banka';

    let gotovinaId = null, bankaUplataId = null;
    if (preostaliDug > 0) {
      // Ima duga (djelimično ili ništa plaćeno) — upiši DVA reda: cijelu preostalu
      // vrijednost kao PLUS (bruto prodaja), i nenaplaćeni dio kao MINUS (dug). Njihov
      // zbir = tačno svježa gotovina primljena sad, ali ostaju vidljiva DVA reda —
      // jedan pokazuje ukupnu prodaju, drugi šta konkretno nije naplaćeno.
      // Kad je nacin='banka', PLUS red ide u banka_uplate umjesto u gotovinu — MINUS
      // (dug) red ostaje u gotovini u oba slučaja (dug je uvijek isto, bez obzira gdje
      // je uplaćeni dio otišao).
      if (jeBanka) {
        if (brutoZaBlagajnu > 0) {
          const b = await client.query(
            `INSERT INTO banka_uplate (iznos, banka, izvor, nalog_r_br, kupac_id, kupac_naziv, objekt_naziv, komercijalista_ime, upisao_id, upisao_ime, napomena)
             VALUES ($1,$2,'Maloprodaja',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [brutoZaBlagajnu, nacin_banka, broj, kupac_id || null, opisKupca, objektNaziv, user.ime_prezime,
             user.id, user.ime_prezime, `Prodaja (bruto) — ${opisKupca}`]
          );
          bankaUplataId = b.rows[0].id;
        }
      } else if (brutoZaBlagajnu > 0) {
        const g = await client.query(
          `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv, nalog_r_br)
           VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3, $4, $5) RETURNING id`,
          [brutoZaBlagajnu, user.ime_prezime, `Prodaja (bruto) — ${opisKupca}`, objektNaziv, broj]
        );
        gotovinaId = g.rows[0].id;
      }
      await client.query(
        `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv, nalog_r_br)
         VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3, $4, $5)`,
        [-preostaliDug, user.ime_prezime, `Dug po otpremnici — ${opisKupca}`, objektNaziv, broj]
      );
    } else if (iznosSada > 0) {
      // Sve plaćeno (bankom/gotovinom, i/ili avansom), nema duga — jedan običan red, u
      // gotovinu ILI u banku_uplate, zavisno od "nacin".
      if (jeBanka) {
        const b = await client.query(
          `INSERT INTO banka_uplate (iznos, banka, izvor, nalog_r_br, kupac_id, kupac_naziv, objekt_naziv, komercijalista_ime, upisao_id, upisao_ime, napomena)
           VALUES ($1,$2,'Maloprodaja',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [iznosSada, nacin_banka, broj, kupac_id || null, opisKupca, objektNaziv, user.ime_prezime, user.id, user.ime_prezime, opisKupca]
        );
        bankaUplataId = b.rows[0].id;
      } else {
        const g = await client.query(
          `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv, nalog_r_br)
           VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3, $4, $5) RETURNING id`,
          [iznosSada, user.ime_prezime, opisKupca, objektNaziv, broj]
        );
        gotovinaId = g.rows[0].id;
      }
    }
    if (gotovinaId) await client.query('UPDATE otpremnice SET gotovina_id=$1 WHERE id=$2', [gotovinaId, otpId]);

    // Kartica kupca: prvo zapiši korišćen avans (ako ga je bilo), pa preostali (novi) dug.
    if (kupac_id) {
      if (iznosIzAvansa > 0) {
        await client.query(
          `INSERT INTO kupac_transakcije
             (kupac_id, tip, iznos, opis, otpremnica_id, otpremnica_broj, objekt_id, objekt_naziv,
              komercijalista_id, komercijalista_ime)
           VALUES ($1,'avans_iskoristen',$2,$3,$4,$5,$6,$7,$8,$9)`,
          [kupac_id, -iznosIzAvansa, `Iskorišten avans za ${broj}`, otpId, broj, objektId, objektNaziv,
           user.id, user.ime_prezime]
        );
      }
      if (preostaliDug > 0) {
        await client.query(
          `INSERT INTO kupac_transakcije
             (kupac_id, tip, iznos, opis, otpremnica_id, otpremnica_broj, objekt_id, objekt_naziv,
              komercijalista_id, komercijalista_ime)
           VALUES ($1,'otpremnica_dug',$2,$3,$4,$5,$6,$7,$8,$9)`,
          [kupac_id, -preostaliDug, `Dug po otpremnici ${broj}`, otpId, broj, objektId, objektNaziv,
           user.id, user.ime_prezime]
        );
      }
    }

    await client.query('COMMIT');
    // Slanje knjigovodstvu se dešava u pozadini — NE čekamo ga (await bez blokiranja
    // odgovora) da eventualni spor/pao email server ne uspori potvrdu prodaje kupcu.
    posaljiOtpremnicuKnjigovodstvu(otpId);
    res.status(201).json({
      ...h.rows[0], gotovina_id: gotovinaId, stavke: sastavljene, iznos_placeno: iznosPlaceno,
      status_placanja: statusPlacanja, duguje: +(ukupanIznos - iznosPlaceno).toFixed(2),
      iznos_iz_avansa: iznosIzAvansa,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/otpremnice/dugovanja?objekt_id=X - lista otpremnica koje nisu u potpunosti
// plaćene. Vidljivo SVIM komercijalistima (ne samo onom ko je napravio prodaju) — kupac
// može doći da plati bilo kom, bilo kad.
router.get('/dugovanja/lista', async (req, res) => {
  try {
    const { objekt_id } = req.query;
    let where = [`status_placanja != 'placeno'`, `status = 'potvrdjena'`];
    let vals = [];
    let i = 1;
    if (objekt_id) { where.push(`objekt_id = $${i++}`); vals.push(objekt_id); }
    const r = await pool.query(
      `SELECT id, broj, datum, kupac_id, kupac_naziv, kupac_telefon, objekt_naziv,
              komercijalista_ime, ukupan_iznos, iznos_placeno, status_placanja,
              (ukupan_iznos - iznos_placeno) AS duguje
       FROM otpremnice WHERE ${where.join(' AND ')} ORDER BY datum ASC`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/otpremnice/dugovanja/kupac/:kupac_id - ukupan dug jednog kupca preko svih
// njegovih otpremnica (bilo koji PJ) — "koliko mi Petar duguje ukupno".
router.get('/dugovanja/kupac/:kupac_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, broj, datum, objekt_naziv, komercijalista_ime,
              ukupan_iznos, iznos_placeno, status_placanja,
              (ukupan_iznos - iznos_placeno) AS duguje
       FROM otpremnice
       WHERE kupac_id = $1 AND status = 'potvrdjena' AND status_placanja != 'placeno'
       ORDER BY datum ASC`,
      [req.params.kupac_id]
    );
    const ukupnoDuguje = r.rows.reduce((s, o) => s + parseFloat(o.duguje), 0);
    res.json({ stavke: r.rows, ukupno_duguje: +ukupnoDuguje.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/:id/naplati-dug - bilježi novu (djelimičnu ili potpunu) naplatu
// duga za jednu otpremnicu. Novac ulazi u blagajnu NA DAN kad je stvarno naplaćen (danas),
// ne na dan prodaje.
// body: { iznos }
router.post('/:id/naplati-dug', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const iznos = parseFloat(req.body.iznos);
  if (!iznos || iznos <= 0) return res.status(400).json({ error: 'Unesite ispravan iznos.' });
  const izvor = req.body.izvor === 'avans' ? 'avans' : 'gotovina';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM otpremnice WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!r.rows.length) throw Object.assign(new Error('Otpremnica nije pronađena.'), { status: 404 });
    const otp = r.rows[0];
    const trenutnoDuguje = +(parseFloat(otp.ukupan_iznos) - parseFloat(otp.iznos_placeno)).toFixed(2);
    if (trenutnoDuguje <= 0)
      throw Object.assign(new Error('Ova otpremnica je već u potpunosti plaćena.'), { status: 400 });

    if (izvor === 'avans') {
      if (!otp.kupac_id) throw Object.assign(new Error('Otpremnica nema povezanog kupca — avans nije moguć.'), { status: 400 });
      const objValRes = await client.query('SELECT valuta FROM prodajni_objekti WHERE id=$1', [otp.objekt_id]);
      const duguValuta = objValRes.rows[0]?.valuta || 'KM';
      // Avans se uzima SAMO iz PJ-eva ISTE valute kao dug koji se naplaćuje.
      const saldoRes = await client.query(
        `SELECT COALESCE(SUM(t.iznos),0) AS saldo FROM kupac_transakcije t
         LEFT JOIN prodajni_objekti p ON p.id = t.objekt_id
         WHERE t.kupac_id=$1 AND COALESCE(p.valuta,'KM') = $2`,
        [otp.kupac_id, duguValuta]
      );
      const saldo = parseFloat(saldoRes.rows[0].saldo);
      if (iznos > saldo)
        throw Object.assign(new Error(`Kupac nema dovoljno avansa u ${duguValuta} (raspoloživo: ${saldo.toFixed(2)} ${duguValuta}).`), { status: 400 });
      if (iznos > trenutnoDuguje)
        throw Object.assign(new Error(`Iznos ne može biti veći od trenutnog duga (${trenutnoDuguje} ${duguValuta}).`), { status: 400 });
    }
    // Za gotovinu dozvoljavamo iznos > trenutnoDuguje (kupac daje više nego što duguje) —
    // višak automatski postaje novi avans (vidi ispod), ne odbija se zahtjev.

    const iznosZaDug = Math.min(iznos, trenutnoDuguje);
    const visak = +(iznos - iznosZaDug).toFixed(2);
    const noviIznosPlaceno = +(parseFloat(otp.iznos_placeno) + iznosZaDug).toFixed(2);
    const noviStatus = noviIznosPlaceno >= parseFloat(otp.ukupan_iznos) ? 'placeno' : 'djelimicno';

    await client.query(
      'UPDATE otpremnice SET iznos_placeno=$1, status_placanja=$2 WHERE id=$3',
      [noviIznosPlaceno, noviStatus, otp.id]
    );

    const opisKupca = otp.kupac_naziv ? otp.kupac_naziv.trim() : 'kupac nepoznat';
    let gotovinaId = null;

    if (izvor === 'gotovina') {
      // Sva gotovina (uključujući eventualni višak) STVARNO ulazi u kasu sada.
      const g = await client.query(
        `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv, nalog_r_br)
         VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3, $4, $5) RETURNING id`,
        [iznos, user.ime_prezime, `Naplata duga — ${opisKupca}${visak > 0 ? ' (uklj. višak u avans)' : ''}`, otp.objekt_naziv, otp.broj]
      );
      gotovinaId = g.rows[0].id;
    }

    if (otp.kupac_id) {
      await client.query(
        `INSERT INTO kupac_transakcije
           (kupac_id, tip, iznos, opis, otpremnica_id, otpremnica_broj, objekt_id, objekt_naziv,
            komercijalista_id, komercijalista_ime, gotovina_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [otp.kupac_id, izvor === 'avans' ? 'avans_iskoristen' : 'naplata_duga', iznosZaDug,
         `Naplata duga za ${otp.broj}`, otp.id, otp.broj, otp.objekt_id, otp.objekt_naziv,
         user.id, user.ime_prezime, gotovinaId]
      );
      if (visak > 0) {
        await client.query(
          `INSERT INTO kupac_transakcije
             (kupac_id, tip, iznos, opis, otpremnica_id, otpremnica_broj, objekt_id, objekt_naziv,
              komercijalista_id, komercijalista_ime, gotovina_id)
           VALUES ($1,'visak_u_avans',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [otp.kupac_id, visak, `Višak pri naplati ${otp.broj} — postaje avans`, otp.id, otp.broj,
           otp.objekt_id, otp.objekt_naziv, user.id, user.ime_prezime, gotovinaId]
        );
      }
    }

    // Log ove konkretne naplate — omogućava STORNO (poništavanje) kasnije, kao cjelina
    // (bez ovoga, nema traga da je BAŠ OVAJ poziv izazvao te promjene, pa se ne bi moglo
    // pouzdano poništiti — npr. ako je neko greškom dva puta kliknuo naplatu).
    const logRes = await client.query(
      `INSERT INTO naplate_duga_log
         (otpremnica_id, otpremnica_broj, iznos, izvor, iznos_za_dug, visak, gotovina_id,
          kupac_id, upisao_id, upisao_ime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [otp.id, otp.broj, iznos, izvor, iznosZaDug, visak, gotovinaId,
       otp.kupac_id || null, user.id, user.ime_prezime]
    );

    await client.query('COMMIT');
    res.json({
      ok: true, otpremnica_id: otp.id, broj: otp.broj, naplaceno_sada: iznosZaDug, visak_u_avans: visak,
      iznos_placeno: noviIznosPlaceno, status_placanja: noviStatus,
      preostalo_duguje: +(parseFloat(otp.ukupan_iznos) - noviIznosPlaceno).toFixed(2),
      gotovina_id: gotovinaId, naplata_log_id: logRes.rows[0].id,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/otpremnice/naplate-log?objekt_id=X&limit=20 - poslednje naplate duga (za brz
// pregled/storno u maloprodaji — npr. "jesam li greškom kliknuo dva puta").
router.get('/naplate-log', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  try {
    const { objekt_id, limit } = req.query;
    const where = [];
    const vals = [];
    let i = 1;
    if (objekt_id) {
      where.push(`otpremnica_id IN (SELECT id FROM otpremnice WHERE objekt_id=$${i++})`);
      vals.push(objekt_id);
    }
    const lim = Math.min(parseInt(limit) || 20, 100);
    vals.push(lim);
    const r = await pool.query(
      `SELECT * FROM naplate_duga_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY kreirano DESC LIMIT $${vals.length}`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/naplate-log/:id/storniraj - poništava JEDNU konkretnu naplatu duga
// kao cjelinu (otpremnica se vraća na staro stanje, gotovina dobija REVERZNI red — ne
// briše se originalni, kupac_transakcije dobijaju svoj reverzni par). Trag ostaje potpun:
// oba (originalni i reverzni) reda su vidljiva, ništa se ne briše.
router.post('/naplate-log/:id/storniraj', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const logRes = await client.query('SELECT * FROM naplate_duga_log WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!logRes.rows.length) throw Object.assign(new Error('Zapis nije pronađen.'), { status: 404 });
    const log = logRes.rows[0];
    if (log.stornirano) throw Object.assign(new Error('Ova naplata je već stornirana.'), { status: 400 });

    const otpRes = await client.query('SELECT * FROM otpremnice WHERE id=$1 FOR UPDATE', [log.otpremnica_id]);
    if (!otpRes.rows.length) throw Object.assign(new Error('Otpremnica nije pronađena.'), { status: 404 });
    const otp = otpRes.rows[0];

    // Vrati otpremnicu na staro stanje — umanji iznos_placeno za ono što je OVA naplata
    // dodala (i za dug-dio i za eventualni višak, pošto je i višak povećao iznos_placeno).
    const ukupnoZaVratiti = +(parseFloat(log.iznos_za_dug) + parseFloat(log.visak)).toFixed(2);
    const noviIznosPlaceno = +(parseFloat(otp.iznos_placeno) - ukupnoZaVratiti).toFixed(2);
    const noviStatus = noviIznosPlaceno <= 0.005 ? 'duguje' : (noviIznosPlaceno >= parseFloat(otp.ukupan_iznos) ? 'placeno' : 'djelimicno');
    await client.query(
      'UPDATE otpremnice SET iznos_placeno=$1, status_placanja=$2 WHERE id=$3',
      [Math.max(0, noviIznosPlaceno), noviStatus, otp.id]
    );

    // Reverzni red u gotovini (ako je izvor bio gotovina — avans ne dira gotovinu).
    if (log.gotovina_id) {
      await client.query(
        `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv, nalog_r_br)
         VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3, $4, $5)`,
        [-parseFloat(log.iznos), user.ime_prezime, `STORNO naplate — ${log.otpremnica_broj}`, otp.objekt_naziv, otp.broj]
      );
    }

    // Reverzni par u kartici kupca (ako je postojao kupac_id).
    if (log.kupac_id) {
      await client.query(
        `INSERT INTO kupac_transakcije
           (kupac_id, tip, iznos, opis, otpremnica_id, otpremnica_broj, objekt_id, objekt_naziv,
            komercijalista_id, komercijalista_ime)
         VALUES ($1,'naplata_duga',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [log.kupac_id, ukupnoZaVratiti, `STORNO naplate za ${otp.broj}`, otp.id, otp.broj,
         otp.objekt_id, otp.objekt_naziv, user.id, user.ime_prezime]
      );
    }

    await client.query(
      `UPDATE naplate_duga_log SET stornirano=true, stornirao_id=$1, stornirao_ime=$2, stornirano_kada=now() WHERE id=$3`,
      [user.id, user.ime_prezime, log.id]
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

// GET /api/otpremnice/kupac/:kupac_id/saldo - trenutni saldo kupca (pozitivan = avans,
// negativan = duguje) — koristi se za predlog "iskoristi avans" pri prodaji/naplati.
router.get('/kupac/:kupac_id/saldo', async (req, res) => {
  try {
    const { objekt_id } = req.query;
    // Ako je poznat PJ za koji se provjerava avans, uzimaj SAMO transakcije iz PJ-eva
    // ISTE valute — avans zarađen u EUR ne treba tiho da pokriva kupovinu u KM (i obrnuto)
    // bez jasne, namjerne odluke/konverzije. Bez objekt_id (stariji pozivi) — staro
    // ponašanje (sve zajedno), radi bezbjednosti unazad.
    if (objekt_id) {
      const objRes = await pool.query('SELECT valuta FROM prodajni_objekti WHERE id=$1', [objekt_id]);
      const valuta = objRes.rows[0]?.valuta || 'KM';
      const r = await pool.query(
        `SELECT COALESCE(SUM(t.iznos),0) AS saldo FROM kupac_transakcije t
         LEFT JOIN prodajni_objekti p ON p.id = t.objekt_id
         WHERE t.kupac_id=$1 AND COALESCE(p.valuta,'KM') = $2`,
        [req.params.kupac_id, valuta]
      );
      return res.json({ saldo: +parseFloat(r.rows[0].saldo).toFixed(2), valuta });
    }
    const r = await pool.query(
      `SELECT COALESCE(SUM(iznos),0) AS saldo FROM kupac_transakcije WHERE kupac_id=$1`,
      [req.params.kupac_id]
    );
    res.json({ saldo: +parseFloat(r.rows[0].saldo).toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/otpremnice/kupac/:kupac_id/kartica - istorija svih transakcija (avansi,
// dugovi, naplate) jednog kupca, sa saldom.
router.get('/kupac/:kupac_id/kartica', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.*, COALESCE(p.valuta,'KM') AS valuta
       FROM kupac_transakcije t
       LEFT JOIN prodajni_objekti p ON p.id = t.objekt_id
       WHERE t.kupac_id=$1 ORDER BY t.datum DESC`,
      [req.params.kupac_id]
    );
    // Saldo (ukupno) je uvijek u KM-ekvivalentu — ako je kupac transakcije obavljao u
    // više PJ (neki EUR, neki KM), ne bi imalo smisla prikazati "zbir" u samo jednoj
    // od tih valuta bez konverzije. Pojedinačne stavke ISPOD ostaju u SVOJOJ nativnoj
    // valuti (frontend to prikazuje po redu, ne po trenutno izabranom PJ).
    const saldo = r.rows.reduce((s, t) => s + parseFloat(t.iznos) * (t.valuta === 'EUR' ? 1.95 : 1), 0);
    res.json({ transakcije: r.rows, saldo: +saldo.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/otpremnice/saldo-po-kupcima?objekt_id=X - lista SVIH kupaca sa saldom != 0
// (pozitivan = avans/zeleno, negativan = duguje/crveno) — za tab "Ne saldirano".
// POST /api/otpremnice/rucni-dug - RUČNI unos istorijskog duga (nastao PRIJE uvođenja
// ovog sistema, npr. iz Excel/papirne evidencije) — BEZ stavki robe i BEZ diranja stanja
// (roba je odavno izašla nekim drugim putem, ne kroz ovaj sistem). Samo admin, jer je ovo
// administrativna korekcija/uvoz podataka, ne stvarna prodaja.
// body: { objekt_id, kupac_naziv, kupac_id, ukupan_iznos, iznos_vec_placeno, datum, napomena }
router.post('/rucni-dug', async (req, res) => {
  const user = req.session?.user;
  if (user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin može ručno unositi istorijske dugove.' });

  const objektId = trebaObjekat(req.body.objekt_id);
  if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
  const { kupac_naziv, kupac_id, napomena } = req.body;
  const ukupanIznos = parseFloat(req.body.ukupan_iznos);
  const iznosVecPlaceno = parseFloat(req.body.iznos_vec_placeno) || 0;
  const datum = req.body.datum || null; // opciono — dozvoljava unos sa STARIM datumom

  if (!ukupanIznos || ukupanIznos <= 0)
    return res.status(400).json({ error: 'Unesite ispravan ukupan iznos.' });
  if (iznosVecPlaceno < 0 || iznosVecPlaceno > ukupanIznos)
    return res.status(400).json({ error: 'Već plaćeni iznos mora biti između 0 i ukupnog iznosa.' });
  if (!kupac_naziv || !kupac_naziv.trim())
    return res.status(400).json({ error: 'Naziv/ime kupca je obavezno.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const objRes = await client.query('SELECT naziv FROM prodajni_objekti WHERE id=$1', [objektId]);
    if (!objRes.rows.length) throw Object.assign(new Error('Prodajni objekat nije pronađen.'), { status: 404 });
    const objektNaziv = objRes.rows[0].naziv;

    const statusPlacanja = iznosVecPlaceno >= ukupanIznos ? 'placeno' : (iznosVecPlaceno > 0 ? 'djelimicno' : 'duguje');
    const broj = await noviBrojDug(client);
    const javniToken = crypto.randomBytes(20).toString('hex');

    const h = await client.query(
      `INSERT INTO otpremnice
         (broj, komercijalista_id, komercijalista_ime, objekt_id, objekt_naziv,
          kupac_id, kupac_naziv, javni_token, ukupan_iznos, status, ima_odstupanje,
          potvrdio_kupac_ime, potvrdjeno_vrijeme, iznos_placeno, status_placanja,
          napomena, rucni_unos, datum)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'potvrdjena',false,$10, now(), $11,$12,$13,true, COALESCE($14, now()))
       RETURNING *`,
      [broj, user.id, user.ime_prezime, objektId, objektNaziv,
       kupac_id || null, kupac_naziv.trim(), javniToken, ukupanIznos,
       '(ručni unos — ' + user.ime_prezime + ')', iznosVecPlaceno, statusPlacanja,
       napomena || null, datum]
    );

    // NAPOMENA: iznos_vec_placeno se NE upisuje u gotovina — to je STARI novac (već primljen
    // prije ovog unosa, negdje van sistema), ne novac primljen danas. U blagajnu bi ušao samo
    // budući iznos naplaćen kroz POST /:id/naplati-dug, kad se stvarno desi.

    await client.query('COMMIT');
    res.status(201).json({ ...h.rows[0], duguje: +(ukupanIznos - iznosVecPlaceno).toFixed(2) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/otpremnice/:id/oznaci-poslato-knjigovodstvu - ručno markiranje "poslato" BEZ
// slanja emaila — koristi se kad se otpremnica šalje knjigovodstvu preko Viber/WhatsApp/
// lokalnog mail klijenta (ne preko server SMTP-a), pa server ne može sam da zna da je
// stvarno poslato — korisnik to potvrđuje ručno nakon što stvarno pošalje.
router.post('/:id/oznaci-poslato-knjigovodstvu', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE otpremnice SET poslato_knjigovodstvu=true, poslato_knjigovodstvu_vrijeme=now()
       WHERE id=$1 RETURNING poslato_knjigovodstvu_vrijeme`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Otpremnica nije pronađena.' });
    res.json({ ok: true, poslato_vrijeme: r.rows[0].poslato_knjigovodstvu_vrijeme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/:id/posalji-knjigovodstvu - ručno (ponovo) slanje, npr. ako
// automatski email nije prošao, ili PJ nije imao podešenu adresu u trenutku prodaje.
router.post('/:id/posalji-knjigovodstvu', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, objekt_id FROM otpremnice WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Otpremnica nije pronađena.' });
    const objRes = await pool.query('SELECT email_knjigovodstvo, naziv FROM prodajni_objekti WHERE id=$1', [r.rows[0].objekt_id]);
    if (!objRes.rows[0]?.email_knjigovodstvo)
      return res.status(400).json({ error: `Prodajni objekat "${objRes.rows[0]?.naziv || ''}" nema podešenu email adresu knjigovodstva.` });
    await posaljiOtpremnicuKnjigovodstvu(r.rows[0].id);
    const provjera = await pool.query('SELECT poslato_knjigovodstvu, poslato_knjigovodstvu_vrijeme FROM otpremnice WHERE id=$1', [r.rows[0].id]);
    if (!provjera.rows[0].poslato_knjigovodstvu)
      return res.status(500).json({ error: 'Slanje nije uspjelo — provjeri email podešavanja (SMTP) na serveru.' });
    res.json({ ok: true, poslato_vrijeme: provjera.rows[0].poslato_knjigovodstvu_vrijeme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/otpremnice/:id/storniraj - SAMO admin. Poništava otpremnicu BEZ brisanja —
// vraća stanje robe, poništava (ne briše) sve gotovinske i kartica-kupca zapise kroz
// suprotne (reverzne) stavke, i šalje STORNO obavještenje knjigovodstvu. Ništa se ne
// briše — cijela istorija ostaje vidljiva i pratljiva.
router.post('/:id/storniraj', async (req, res) => {
  const user = req.session?.user;
  if (user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin može stornirati otpremnicu.' });
  const napomenaStorno = (req.body?.napomena || '').trim() || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const otpRes = await client.query('SELECT * FROM otpremnice WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!otpRes.rows.length) throw Object.assign(new Error('Otpremnica nije pronađena.'), { status: 404 });
    const otp = otpRes.rows[0];
    if (otp.status === 'stornirana')
      throw Object.assign(new Error('Otpremnica je već stornirana.'), { status: 400 });
    if (otp.status !== 'potvrdjena')
      throw Object.assign(new Error('Može se stornirati samo potvrđena otpremnica.'), { status: 400 });

    // 1) Vrati stanje robe (+kolicina za svaku stavku, samo za ovaj PJ).
    const stavkeRes = await client.query('SELECT * FROM otpremnica_stavke WHERE otpremnica_id=$1', [otp.id]);
    for (const s of stavkeRes.rows) {
      await client.query(
        'UPDATE roba_pj SET stanje = stanje + $1, azurirano = now() WHERE roba_id=$2 AND objekt_id=$3',
        [s.kolicina, s.roba_id, otp.objekt_id]
      );
    }

    // 2) Poništi SVE gotovinske zapise vezane za ovu otpremnicu (i inicijalnu prodaju/dug,
    // i sve naknadne naplate duga koje su se možda desile poslije) — po JEDNOM reverznom
    // (suprotnog predznaka) redu za svaki postojeći, ništa se ne briše.
    const gotRes = await client.query(
      `SELECT * FROM gotovina WHERE nalog_r_br = $1 AND izvor = 'Maloprodaja'`,
      [otp.broj]
    );
    for (const g of gotRes.rows) {
      await client.query(
        `INSERT INTO gotovina (datum, iznos, primio, izvor, opis, objekt_naziv, nalog_r_br)
         VALUES (CURRENT_DATE, $1, $2, 'Maloprodaja', $3, $4, $5)`,
        [-g.iznos, user.ime_prezime, `STORNO — ${g.opis}`, g.objekt_naziv, otp.broj]
      );
    }

    // 3) Poništi SVE kartica-kupca zapise vezane za ovu otpremnicu (avans iskorišten, dug,
    // naplate duga) — po jedan reverzni red za svaki, tako da saldo kupca ponovo bude tačan
    // kao da otpremnica nikad nije ni postojala.
    const ktRes = await client.query(
      `SELECT * FROM kupac_transakcije WHERE otpremnica_id = $1`,
      [otp.id]
    );
    for (const t of ktRes.rows) {
      await client.query(
        `INSERT INTO kupac_transakcije
           (kupac_id, tip, iznos, opis, otpremnica_id, otpremnica_broj, objekt_id, objekt_naziv,
            komercijalista_id, komercijalista_ime)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [t.kupac_id, t.tip, -t.iznos, `STORNO — ${t.opis || ''}`, otp.id, otp.broj,
         otp.objekt_id, otp.objekt_naziv, user.id, user.ime_prezime]
      );
    }

    // 4) Označi otpremnicu stornirano — NE BRIŠE se, ostaje vidljiva u istoriji.
    await client.query(
      `UPDATE otpremnice SET status='stornirana', napomena=COALESCE(napomena||' | ','')||$1
       WHERE id=$2`,
      [`STORNO (${user.ime_prezime}, ${new Date().toISOString().split('T')[0]})${napomenaStorno ? ': ' + napomenaStorno : ''}`, otp.id]
    );

    await client.query('COMMIT');

    // 5) Obavijesti knjigovodstvo (van transakcije — ne smije zaustaviti storno ako padne).
    try {
      const objRes = await pool.query('SELECT email_knjigovodstvo FROM prodajni_objekti WHERE id=$1', [otp.objekt_id]);
      const email = objRes.rows[0]?.email_knjigovodstvo;
      if (email) {
        await posaljiEmail(
          email,
          `STORNO otpremnice ${otp.broj} — ${otp.objekt_naziv}`,
          `<div style="font-family:Arial,sans-serif;font-size:13px;color:#1a2733;">
             <h2 style="color:#c00000;">⚠ STORNIRANO — Otpremnica ${otp.broj}</h2>
             <p>Ova otpremnica je stornirana u JoPeX sistemu ${new Date().toLocaleString('sr-Latn-BA')} (izvršio: ${esc(user.ime_prezime)}).</p>
             <p><b>Molimo izbrišite/korigujte odgovarajući unos u Bluesoft-u.</b></p>
             <p>Kupac: ${esc(otp.kupac_naziv || '—')} · Ukupan iznos: ${parseFloat(otp.ukupan_iznos).toFixed(2)} KM</p>
           </div>`
        );
      }
    } catch (e) { console.error('Slanje storno obavještenja nije uspjelo:', e.message); }

    res.json({ ok: true, broj: otp.broj });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Dnevni zbirni pregled — jedan email po PJ (koji ima podešenu adresu) sa SVIM
// otpremnicama potvrđenim TOG DANA. Poziva se sa rasporedom iz server.js (jednom uveče).
// Bilježi se u knjigovodstvo_dnevni_log da se ne pošalje duplo isti dan ako se server
// restartuje.
async function posaljiDnevniPregledSvimaPJ() {
  try {
    const danas = new Date().toISOString().split('T')[0];
    const objekti = await pool.query(
      `SELECT id, naziv, email_knjigovodstvo FROM prodajni_objekti
       WHERE email_knjigovodstvo IS NOT NULL AND aktivan = true`
    );
    for (const obj of objekti.rows) {
      const vecPoslato = await pool.query(
        'SELECT 1 FROM knjigovodstvo_dnevni_log WHERE objekt_id=$1 AND datum=$2',
        [obj.id, danas]
      );
      if (vecPoslato.rows.length) continue; // već poslato danas za ovaj PJ

      const otpR = await pool.query(
        `SELECT * FROM otpremnice WHERE objekt_id=$1 AND status='potvrdjena'
         AND datum::date = $2::date ORDER BY datum ASC`,
        [obj.id, danas]
      );
      if (!otpR.rows.length) continue; // nema otpremnica danas za ovaj PJ — ne šalji prazan email

      const redovi = otpR.rows.map(o => `
        <tr>
          <td style="padding:5px 8px;border-bottom:1px solid #eee;">${o.broj}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #eee;">${o.kupac_naziv || '—'}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:right;">${parseFloat(o.ukupan_iznos).toFixed(2)} KM</td>
          <td style="padding:5px 8px;border-bottom:1px solid #eee;">${o.status_placanja === 'placeno' ? 'Plaćeno' : o.status_placanja === 'djelimicno' ? 'Djelimično' : 'Na račun'}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #eee;">${o.poslato_knjigovodstvu ? '✓' : '⏳'}</td>
        </tr>
      `).join('');
      const ukupno = otpR.rows.reduce((s, o) => s + parseFloat(o.ukupan_iznos), 0);
      const html = `
        <div style="font-family:Arial,sans-serif;font-size:13px;color:#1a2733;max-width:640px;">
          <h2 style="color:#134a85;">Dnevni pregled otpremnica — ${obj.naziv} — ${danas}</h2>
          <table style="border-collapse:collapse;width:100%;font-size:12.5px;">
            <thead><tr style="background:#f0f2f5;">
              <th style="padding:5px 8px;text-align:left;">Broj</th>
              <th style="padding:5px 8px;text-align:left;">Kupac</th>
              <th style="padding:5px 8px;text-align:right;">Iznos</th>
              <th style="padding:5px 8px;text-align:left;">Plaćanje</th>
              <th style="padding:5px 8px;text-align:left;">Poslato pojedinačno</th>
            </tr></thead>
            <tbody>${redovi}</tbody>
          </table>
          <p style="text-align:right;font-size:14px;font-weight:bold;margin-top:8px;">UKUPNO DANAS: ${ukupno.toFixed(2)} KM (${otpR.rows.length} otpremnica)</p>
          <p style="color:#8b96a5;font-size:11px;margin-top:16px;">Automatski dnevni pregled iz JoPeX sistema.</p>
        </div>
      `;
      const rezultat = await posaljiEmail(obj.email_knjigovodstvo, `Dnevni pregled otpremnica — ${obj.naziv} — ${danas}`, html);
      if (rezultat.ok) {
        await pool.query(
          `INSERT INTO knjigovodstvo_dnevni_log (objekt_id, datum, broj_otpremnica) VALUES ($1,$2,$3)
           ON CONFLICT (objekt_id, datum) DO NOTHING`,
          [obj.id, danas, otpR.rows.length]
        );
      } else {
        console.error(`Dnevni pregled za PJ ${obj.naziv} nije poslat:`, rezultat.error);
      }
    }
  } catch (err) {
    console.error('Greška u posaljiDnevniPregledSvimaPJ:', err.message);
  }
}

router.posaljiDnevniPregled = posaljiDnevniPregledSvimaPJ;

module.exports = router;
