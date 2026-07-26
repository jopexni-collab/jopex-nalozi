// routes/terenske-ponude.js
const express = require('express');
const router = express.Router();
const pool = require('./db');

// Ko sme da koristi ovaj modul uopšte: admin, terenac (komercijalista_teren), ili bilo ko
// sa "Ponude sve" dozvolom (moze_ugovarati — isti krug ljudi kao Generator ponuda, sad
// koriste i "Ponude robe" i mogu potvrđivati/otkazivati terenske ponude).
function jeTerenacIliAdmin(user) {
  return !!user && (user.rola === 'admin' || user.komercijalista_teren || user.moze_ugovarati);
}

// GET /api/terenske-ponude - lista (admin i "Ponude sve" vide SVE, terenac bez te
// dozvole vidi SAMO svoje)
router.get('/', async (req, res) => {
  const user = req.session?.user;
  if (!jeTerenacIliAdmin(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const vidiSve = user.rola === 'admin' || user.moze_ugovarati;
    const { status } = req.query;
    const where = [];
    const vals = [];
    let i = 1;
    if (!vidiSve) { where.push(`komercijalista_id = $${i++}`); vals.push(user.id); }
    if (status) { where.push(`status = $${i++}`); vals.push(status); }
    const r = await pool.query(
      `SELECT * FROM terenske_ponude ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY datum DESC LIMIT 200`,
      vals
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/terenske-ponude/:id - detalj sa stavkama
router.get('/:id', async (req, res) => {
  const user = req.session?.user;
  if (!jeTerenacIliAdmin(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const h = await pool.query('SELECT * FROM terenske_ponude WHERE id=$1', [req.params.id]);
    if (!h.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    const ponuda = h.rows[0];
    if (user.rola !== 'admin' && !user.moze_ugovarati && ponuda.komercijalista_id !== user.id)
      return res.status(403).json({ error: 'Nema pristupa.' });
    const s = await pool.query('SELECT * FROM terenska_ponuda_stavke WHERE ponuda_id=$1 ORDER BY id', [req.params.id]);
    res.json({ ...ponuda, stavke: s.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/terenske-ponude - kreira novu ponudu sa mešovitim stavkama (lager + proizvodnja)
router.post('/', async (req, res) => {
  const user = req.session?.user;
  if (!jeTerenacIliAdmin(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  const {
    kupac_naziv, kupac_telefon, kupac_adresa, objekt_id, napomena, stavke,
    nacin_placanja, valuta, paritet, paritet_adresa, vreme_isporuke, vazi_do,
  } = req.body || {};
  if (!kupac_naziv?.trim()) return res.status(400).json({ error: 'Naziv kupca je obavezan.' });
  if (!Array.isArray(stavke) || !stavke.length)
    return res.status(400).json({ error: 'Ponuda mora imati bar jednu stavku.' });
  const imaLager = stavke.some(s => s.tip === 'lager');
  if (imaLager && !objekt_id)
    return res.status(400).json({ error: 'Prodajni objekat je obavezan kad ponuda ima stavke sa lagera.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const javniToken = require('crypto').randomBytes(20).toString('hex');
    const h = await client.query(
      `INSERT INTO terenske_ponude
         (komercijalista_id, komercijalista_ime, kupac_naziv, kupac_telefon, kupac_adresa,
          objekt_id, napomena, status, nacin_placanja, valuta, paritet, paritet_adresa,
          vreme_isporuke, vazi_do, javni_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'poslato',$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [user.id, user.ime_prezime, kupac_naziv.trim(), kupac_telefon || null,
       kupac_adresa || null, objekt_id || null, napomena || null,
       nacin_placanja || null, valuta || 'KM', paritet || null, paritet_adresa || null,
       vreme_isporuke || null, vazi_do || null, javniToken]
    );
    const ponuda = h.rows[0];

    for (const s of stavke) {
      if (s.tip === 'lager') {
        await client.query(
          `INSERT INTO terenska_ponuda_stavke (ponuda_id, tip, roba_id, sifra, naziv, jed_mjera, kolicina, cijena, link_slika)
           VALUES ($1,'lager',$2,$3,$4,$5,$6,$7,$8)`,
          [ponuda.id, s.roba_id, s.sifra, s.naziv, s.jed_mjera, s.kolicina, s.cijena, s.link_slika || null]
        );
      } else if (s.tip === 'proizvodnja') {
        await client.query(
          `INSERT INTO terenska_ponuda_stavke (ponuda_id, tip, zadatak, materijal, napomena_stavka, cijena_proizvodnja, kategorija_bonus_id)
           VALUES ($1,'proizvodnja',$2,$3,$4,$5,$6)`,
          [ponuda.id, s.zadatak, s.materijal || null, s.napomena_stavka || null, s.cijena_proizvodnja || 0, s.kategorija_bonus_id || null]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: ponuda.id, javni_token: javniToken });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/terenske-ponude/:id/otkazi
router.post('/:id/otkazi', async (req, res) => {
  const user = req.session?.user;
  if (!jeTerenacIliAdmin(user)) return res.status(403).json({ error: 'Nema pristupa.' });
  try {
    const h = await pool.query('SELECT * FROM terenske_ponude WHERE id=$1', [req.params.id]);
    if (!h.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    if (h.rows[0].status !== 'poslato')
      return res.status(400).json({ error: 'Samo ponude koje čekaju potvrdu mogu biti otkazane.' });
    await pool.query("UPDATE terenske_ponude SET status='otkazano' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/terenske-ponude/:id/potvrdi — SAMO ADMIN. Razdvaja mešovitu ponudu:
// sve "lager" stavke → JEDNA otpremnica (skida stanje, kao normalna maloprodaja),
// sve "proizvodnja" stavke → JEDAN radni nalog (velika_ponuda, sve stavke zajedno —
// isti princip kao Generator ponuda).
router.post('/:id/potvrdi', async (req, res) => {
  const user = req.session?.user;
  // Potvrđuje admin ILI bilo ko sa "Ponude sve" dozvolom (moze_ugovarati) — isti krug
  // ljudi koji već rade Generator ponuda i Ponude robe.
  if (user?.rola !== 'admin' && !user?.moze_ugovarati)
    return res.status(403).json({ error: 'Samo admin ili osoba sa "Ponude sve" dozvolom može potvrditi ponudu.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const h = await client.query('SELECT * FROM terenske_ponude WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!h.rows.length) throw Object.assign(new Error('Ponuda nije pronađena.'), { status: 404 });
    const ponuda = h.rows[0];
    if (ponuda.status !== 'poslato')
      throw Object.assign(new Error('Ponuda je već obrađena (potvrđena ili otkazana).'), { status: 400 });

    const sRes = await client.query('SELECT * FROM terenska_ponuda_stavke WHERE ponuda_id=$1 ORDER BY id', [req.params.id]);
    const stavke = sRes.rows;
    const lagerStavke = stavke.filter(s => s.tip === 'lager');
    const proizvodnjaStavke = stavke.filter(s => s.tip === 'proizvodnja');

    let otpremnicaId = null, radniNalogRBr = null;

    // ── LAGER STAVKE → JEDNA OTPREMNICA ──────────────────────────────────────
    if (lagerStavke.length) {
      const objRes = await client.query('SELECT naziv, valuta FROM prodajni_objekti WHERE id=$1 AND aktivan=true', [ponuda.objekt_id]);
      if (!objRes.rows.length) throw Object.assign(new Error('Prodajni objekat nije pronađen ili nije aktivan.'), { status: 400 });
      const objektNaziv = objRes.rows[0].naziv;

      // Provjeri stanje uživo (zaključaj redove protiv trke)
      const robaIdjevi = lagerStavke.map(s => s.roba_id).filter(Boolean);
      if (robaIdjevi.length) {
        await client.query('SELECT id FROM roba_pj WHERE roba_id = ANY($1::int[]) AND objekt_id=$2 FOR UPDATE', [robaIdjevi, ponuda.objekt_id]);
      }
      const ukupanIznos = +lagerStavke.reduce((s, x) => s + parseFloat(x.kolicina) * parseFloat(x.cijena), 0).toFixed(2);

      const godina = new Date().getFullYear();
      const seq = await client.query("SELECT nextval('otpremnica_broj_seq') AS n");
      const broj = `OTP-${godina}-${String(seq.rows[0].n).padStart(6, '0')}`;
      const javniToken = require('crypto').randomBytes(20).toString('hex');

      const oh = await client.query(
        `INSERT INTO otpremnice
           (broj, komercijalista_id, komercijalista_ime, objekt_id, objekt_naziv,
            kupac_naziv, kupac_adresa, kupac_telefon, javni_token, ukupan_iznos, status,
            ima_odstupanje, potvrdio_kupac_ime, potvrdjeno_vrijeme, iznos_placeno, status_placanja, napomena)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'potvrdjena',false,$11,now(),0,'duguje',$12) RETURNING id`,
        [broj, ponuda.komercijalista_id, ponuda.komercijalista_ime, ponuda.objekt_id, objektNaziv,
         ponuda.kupac_naziv, ponuda.kupac_adresa, ponuda.kupac_telefon, javniToken, ukupanIznos,
         ponuda.kupac_naziv, `Generisano iz terenske ponude #${ponuda.id}`]
      );
      otpremnicaId = oh.rows[0].id;

      for (const s of lagerStavke) {
        const iznos = +(parseFloat(s.kolicina) * parseFloat(s.cijena)).toFixed(2);
        await client.query(
          `INSERT INTO otpremnica_stavke (otpremnica_id, roba_id, sifra, naziv, jed_mjera, kolicina, cijena_zadana, cijena, iznos)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
          [otpremnicaId, s.roba_id, s.sifra, s.naziv, s.jed_mjera, s.kolicina, s.cijena, iznos]
        );
        if (s.roba_id) {
          await client.query(
            'UPDATE roba_pj SET stanje = stanje - $1, azurirano = now() WHERE roba_id=$2 AND objekt_id=$3',
            [s.kolicina, s.roba_id, ponuda.objekt_id]
          );
        }
      }
    }

    // ── PROIZVODNJA STAVKE → JEDAN RADNI NALOG (sve zajedno) ──────────────────
    if (proizvodnjaStavke.length) {
      const zadatak = proizvodnjaStavke.map(s => s.zadatak).filter(Boolean).join(' + ');
      const materijal = [...new Set(proizvodnjaStavke.map(s => s.materijal).filter(Boolean))].join(', ');
      const napomena = proizvodnjaStavke.map(s => s.napomena_stavka).filter(Boolean).join(' | ');
      const ugovorenaSuma = +proizvodnjaStavke.reduce((s, x) => s + parseFloat(x.cijena_proizvodnja || 0), 0).toFixed(2);
      // Ako stavke imaju RAZLIČITE kategorije, uzima se kategorija PRVE (nalog je jedan,
      // može imati samo JEDNU kategoriju) — poznato ograničenje, vidi napomenu u razgovoru.
      const kategorijaId = proizvodnjaStavke.find(s => s.kategorija_bonus_id)?.kategorija_bonus_id || null;

      const nr = await client.query(
        `INSERT INTO proizvodnja_jopex
           (zadatak, prioritet, status, ugovorio_id, ugovorio, narucilac, materijal, napomena,
            ugovorena_suma, avans, pocetak, izvor, kategorija_bonus_id)
         VALUES ($1,'Normal','Nije Započeto',$2,$3,$4,$5,$6,$7,0,CURRENT_DATE,'velika_ponuda',$8)
         RETURNING r_br`,
        [zadatak || 'Terenska ponuda', ponuda.komercijalista_id, ponuda.komercijalista_ime,
         ponuda.kupac_naziv, materijal || null,
         `${napomena}${napomena ? ' — ' : ''}Generisano iz terenske ponude #${ponuda.id}`, ugovorenaSuma, kategorijaId]
      );
      radniNalogRBr = nr.rows[0].r_br;
    }

    await client.query(
      `UPDATE terenske_ponude SET status='potvrdjeno', potvrdjeno_kada=now(), potvrdio_id=$1, potvrdio_ime=$2,
         otpremnica_id=$3, radni_nalog_r_br=$4 WHERE id=$5`,
      [user.id, user.ime_prezime, otpremnicaId, radniNalogRBr, ponuda.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, otpremnica_id: otpremnicaId, radni_nalog_r_br: radniNalogRBr });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
