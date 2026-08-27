// kalkulacije.js — dokument prijema robe preko kontejnera: nabavka (EUR/USD) + brodarina +
// troškovi u KM + carinski obračun (osnovica → carina → PDV, dodaju se na realnu fakturu)
// + finansijska obaveza prema dobavljaču (avans/ostatak/realna faktura, koja može stići
// kasnije, drugačija od profakture). Zadržan je i postojeći mehanizam raspoređivanja
// troškova po stavci (za pravu nabavnu/prodajnu cijenu artikala) — carina se automatski
// uključuje u taj raspored, PDV NE (jer je obično povratan/odbitan, ne stvaran trošak).
const express = require('express');
const router = express.Router();
const pool = require('./db');

// GET /api/kalkulacije?objekt_id=X — lista (najnovije prvo).
/* Citanje brojeva sa ZAREZOM kao decimalom — isto pravilo kao u pregledacu.
   Bez ovoga parseFloat("1.234,56") vraca 1.234 (hiljadu puta manje), a "17,55" vraca 17
   — tiho se gube pare. */
function broj(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(/,/g, '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

router.get('/', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const { objekt_id } = req.query;
    let where = '';
    let vals = [];
    if (objekt_id) { where = 'WHERE objekt_id=$1'; vals.push(objekt_id); }
    const r = await pool.query(
      `SELECT k.*, COALESCE((SELECT COUNT(*) FROM kalkulacija_stavke WHERE kalkulacija_id=k.id),0) AS broj_stavki
       FROM kalkulacije k ${where} ORDER BY k.kreirano DESC`,
      vals
    );
    res.json(r.rows.map(dodajUkupnoZaduzenje));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kalkulacije/:id — jedna kalkulacija sa stavkama.
router.get('/:id', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  try {
    const zag = await pool.query('SELECT * FROM kalkulacije WHERE id=$1', [req.params.id]);
    if (!zag.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    const stavke = await pool.query('SELECT * FROM kalkulacija_stavke WHERE kalkulacija_id=$1 ORDER BY id', [req.params.id]);
    res.json({ ...dodajUkupnoZaduzenje(zag.rows[0]), stavke: stavke.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ukupno zaduženje prema dobavljaču = (realna faktura, ili nabavka ako realna još nije
// stigla) × kurs + brodarina × kurs + luka + drugi troškovi (KM) + carina + PDV.
// Računa se pri ČITANJU (ne čuva se u bazi) da uvijek odražava trenutne vrijednosti.
function dodajUkupnoZaduzenje(k) {
  const vrijednostRobe = k.realna_faktura_primljena && k.realna_faktura_iznos != null
    ? broj(k.realna_faktura_iznos) : broj(k.vrednost_nabavke || 0);
  const kurs = broj(k.kurs) || 1;
  const ukupno =
    vrijednostRobe * kurs +
    broj(k.vrednost_brodarine || 0) * kurs +
    broj(k.trosak_luka_km || 0) +
    broj(k.drugi_troskovi_km || 0) +
    broj(k.iznos_carine || 0) +
    broj(k.iznos_pdv || 0);
  return { ...k, ukupno_zaduzenje_km: +ukupno.toFixed(2) };
}

// POST /api/kalkulacije — kreira dokument. Carina/PDV se AUTOMATSKI računaju iz osnovice
// (koju korisnik ručno unosi SAMO za ovaj obračun — sama osnovica se nigdje dalje ne
// koristi/dodaje). Izračunata carina ulazi u "trosak_carina" (postojeći mehanizam
// raspoređivanja po stavci) — PDV NE ulazi u raspoređivanje (obično je odbitan/povratan).
router.post('/', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  const {
    broj, dobavljac, datum, objekt_id, objekt_naziv,
    broj_kontejnera, eta, broj_fakture_dobavljaca, kupac_direktno,
    valuta_nabavke, vrednost_nabavke, vrednost_brodarine, kurs,
    trosak_luka_km, drugi_troskovi_km,
    osnovica_za_carinjenje, stopa_carine_pct, stopa_pdv_pct,
    avans_uplacen, ostatak_za_uplatu,
    trosak_prevoz, trosak_ostalo, napomena, stavke,
  } = req.body || {};
  if (!dobavljac?.trim()) return res.status(400).json({ error: 'Dobavljač je obavezan.' });
  if (!objekt_id) return res.status(400).json({ error: 'Prodajni objekat je obavezan.' });
  if (!Array.isArray(stavke) || !stavke.length) return res.status(400).json({ error: 'Nema unesenih stavki.' });
  if (!['EUR', 'USD'].includes(valuta_nabavke)) return res.status(400).json({ error: 'Valuta nabavke mora biti EUR ili USD.' });

  // Carina/PDV — izračunato ODMAH (fiksira se u bazi, ne mijenja se ako se stope kasnije
  // promijene za NOVE kalkulacije).
  const osnovica = broj(osnovica_za_carinjenje) || 0;
  const stopaCarine = broj(stopa_carine_pct) || 0;
  const stopaPdv = broj(stopa_pdv_pct) || 0;
  const iznosCarine = +(osnovica * stopaCarine / 100).toFixed(2);
  const iznosPdv = +((osnovica + iznosCarine) * stopaPdv / 100).toFixed(2);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ukupna vrijednost svih stavki (nabavna_cijena × količina) — osnova za proporcionalno
    // raspoređivanje zavisnih troškova (skuplja stavka nosi veći udio). Carina (izračunata
    // gore) se dodaje u "trosak_carina" — PDV se NAMJERNO ne dodaje ovdje.
    const ukupnaVrijednost = stavke.reduce((s, x) => s + (broj(x.nabavna_cijena) || 0) * (broj(x.kolicina) || 0), 0);
    const ukupniTroskovi = (broj(trosak_prevoz) || 0) + iznosCarine + (broj(trosak_ostalo) || 0);
    if (ukupnaVrijednost <= 0) throw Object.assign(new Error('Ukupna vrijednost stavki mora biti veća od 0.'), { status: 400 });

    const zag = await client.query(
      `INSERT INTO kalkulacije
         (broj, dobavljac, datum, objekt_id, objekt_naziv,
          broj_kontejnera, eta, broj_fakture_dobavljaca, kupac_direktno,
          valuta_nabavke, vrednost_nabavke, vrednost_brodarine, kurs,
          trosak_luka_km, drugi_troskovi_km,
          osnovica_za_carinjenje, stopa_carine_pct, stopa_pdv_pct, iznos_carine, iznos_pdv,
          avans_uplacen, ostatak_za_uplatu,
          trosak_prevoz, trosak_carina, trosak_ostalo, napomena, upisao_id, upisao_ime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       RETURNING id`,
      [broj || null, dobavljac.trim(), datum, objekt_id, objekt_naziv || null,
       broj_kontejnera || null, eta || null, broj_fakture_dobavljaca || null, kupac_direktno || null,
       valuta_nabavke, vrednost_nabavke || 0, vrednost_brodarine || 0, kurs || 1,
       trosak_luka_km || 0, drugi_troskovi_km || 0,
       osnovica, stopaCarine, stopaPdv, iznosCarine, iznosPdv,
       avans_uplacen || 0, ostatak_za_uplatu || 0,
       trosak_prevoz || 0, iznosCarine, trosak_ostalo || 0, napomena || null, user.id, user.ime_prezime]
    );
    const kalkulacijaId = zag.rows[0].id;

    let obradjeno = 0;   // koliko stavki je STVARNO uslo u lager
    for (const s of stavke) {
      const kolicina = broj(s.kolicina) || 0;
      const nabavnaCijena = broj(s.nabavna_cijena) || 0;
      const prodajnaCijena = broj(s.prodajna_cijena) || 0;
      /* Ranije se stavka sa kolicinom 0 TIHO preskakala — korisnik potvrdi kalkulaciju,
         dobije poruku da je proslo, a stanje se ne promijeni i nema nikakvog traga zasto.
         Sada se kalkulacija ODBIJA sa jasnim objasnjenjem koja stavka je sporna. */
      obradjeno++;
      if (kolicina <= 0) {
        throw Object.assign(
          new Error(`Stavka "${s.sifra || s.roba_id}" ima količinu 0 — unesi količinu ili je ukloni iz kalkulacije.`),
          { status: 400 }
        );
      }

      const vrijednostStavke = nabavnaCijena * kolicina;
      const udioTroskova = ukupniTroskovi > 0 ? (vrijednostStavke / ukupnaVrijednost) * ukupniTroskovi : 0;
      const pravaNabavnaCijena = (vrijednostStavke + udioTroskova) / kolicina;

      const robaRes = await client.query('SELECT sifra, naziv FROM roba WHERE id=$1', [s.roba_id]);
      if (!robaRes.rows.length) {
        throw Object.assign(
          new Error(`Artikal sa ID ${s.roba_id} ne postoji u šifrarniku.`), { status: 400 }
        );
      }

      await client.query(
        `INSERT INTO kalkulacija_stavke (kalkulacija_id, roba_id, sifra, naziv, kolicina, nabavna_cijena, udio_troskova, prava_nabavna_cijena, prodajna_cijena)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [kalkulacijaId, s.roba_id, robaRes.rows[0].sifra, robaRes.rows[0].naziv, kolicina, nabavnaCijena, udioTroskova, pravaNabavnaCijena, prodajnaCijena]
      );

      const postoji = await client.query('SELECT stanje FROM roba_pj WHERE roba_id=$1 AND objekt_id=$2', [s.roba_id, objekt_id]);
      if (postoji.rows.length) {
        await client.query(
          `UPDATE roba_pj SET stanje = stanje + $1, cijena = $2, nabavna_cijena = $3, azurirano = now()
           WHERE roba_id=$4 AND objekt_id=$5`,
          [kolicina, prodajnaCijena, pravaNabavnaCijena, s.roba_id, objekt_id]
        );
      } else {
        await client.query(
          `INSERT INTO roba_pj (roba_id, objekt_id, stanje, cijena, nabavna_cijena)
           VALUES ($1,$2,$3,$4,$5)`,
          [s.roba_id, objekt_id, kolicina, prodajnaCijena, pravaNabavnaCijena]
        );
      }

      await client.query(
        `INSERT INTO roba_kretanja (roba_id, objekt_id, tip, kolicina, cijena_stara, cijena_nova, napomena, korisnik_id, korisnik_ime)
         VALUES ($1,$2,'kalkulacija',$3,NULL,$4,$5,$6,$7)`,
        [s.roba_id, objekt_id, kolicina, pravaNabavnaCijena,
         `Kalkulacija #${kalkulacijaId} — ${dobavljac.trim()}${broj ? ' (' + broj + ')' : ''}`, user.id, user.ime_prezime]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, id: kalkulacijaId, iznos_carine: iznosCarine, iznos_pdv: iznosPdv, obradjeno_stavki: obradjeno });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/kalkulacije/:id/realna-faktura — kad REALNA faktura konačno stigne (može biti
// drugačija od profakture/inicijalne procjene, saznaje se kasnije) — ažurira finalan iznos
// prema dobavljaču. NE mijenja stavke/cijene artikala (te su već fiksirane pri kreiranju).
router.patch('/:id/realna-faktura', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  const { iznos } = req.body || {};
  if (!(broj(iznos) > 0)) return res.status(400).json({ error: 'Unesite ispravan iznos realne fakture.' });
  try {
    const r = await pool.query(
      `UPDATE kalkulacije SET realna_faktura_iznos=$1, realna_faktura_primljena=true WHERE id=$2 RETURNING *`,
      [iznos, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nije pronađeno.' });
    res.json(dodajUkupnoZaduzenje(r.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
