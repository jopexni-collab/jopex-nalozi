// kalkulacije.js — dokument prijema robe: nabavka + zavisni troškovi (prevoz/carina/
// ostalo) raspoređeni proporcionalno po VREDNOSTI stavke, računa pravu nabavnu cijenu i
// postavlja novu prodajnu cijenu. Uvećava stanje robe i beleži u roba_kretanja.
const express = require('express');
const router = express.Router();
const pool = require('./db');

// GET /api/kalkulacije?objekt_id=X — lista (najnovije prvo).
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
    res.json(r.rows);
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
    res.json({ ...zag.rows[0], stavke: stavke.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kalkulacije — kreira dokument: raspoređuje troškove proporcionalno po
// vrednosti stavke, računa pravu nabavnu cijenu, UVEĆAVA stanje robe (roba_pj), postavlja
// novu prodajnu cijenu, i beleži u roba_kretanja (tip='kalkulacija') za istoriju/karticu.
router.post('/', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  const {
    broj, dobavljac, datum, objekt_id, objekt_naziv,
    trosak_prevoz, trosak_carina, trosak_ostalo, napomena, stavke,
  } = req.body || {};
  if (!dobavljac?.trim()) return res.status(400).json({ error: 'Dobavljač je obavezan.' });
  if (!objekt_id) return res.status(400).json({ error: 'Prodajni objekat je obavezan.' });
  if (!Array.isArray(stavke) || !stavke.length) return res.status(400).json({ error: 'Nema unesenih stavki.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ukupna vrijednost svih stavki (nabavna_cijena × količina) — osnova za proporcionalno
    // raspoređivanje zavisnih troškova (skuplja stavka nosi veći udio).
    const ukupnaVrijednost = stavke.reduce((s, x) => s + (parseFloat(x.nabavna_cijena) || 0) * (parseFloat(x.kolicina) || 0), 0);
    const ukupniTroskovi = (parseFloat(trosak_prevoz) || 0) + (parseFloat(trosak_carina) || 0) + (parseFloat(trosak_ostalo) || 0);
    if (ukupnaVrijednost <= 0) throw Object.assign(new Error('Ukupna vrijednost stavki mora biti veća od 0.'), { status: 400 });

    const zag = await client.query(
      `INSERT INTO kalkulacije (broj, dobavljac, datum, objekt_id, objekt_naziv, trosak_prevoz, trosak_carina, trosak_ostalo, napomena, upisao_id, upisao_ime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [broj || null, dobavljac.trim(), datum, objekt_id, objekt_naziv || null,
       trosak_prevoz || 0, trosak_carina || 0, trosak_ostalo || 0, napomena || null, user.id, user.ime_prezime]
    );
    const kalkulacijaId = zag.rows[0].id;

    for (const s of stavke) {
      const kolicina = parseFloat(s.kolicina) || 0;
      const nabavnaCijena = parseFloat(s.nabavna_cijena) || 0;
      const prodajnaCijena = parseFloat(s.prodajna_cijena) || 0;
      if (kolicina <= 0) continue;

      const vrijednostStavke = nabavnaCijena * kolicina;
      const udioTroskova = ukupniTroskovi > 0 ? (vrijednostStavke / ukupnaVrijednost) * ukupniTroskovi : 0;
      const pravaNabavnaCijena = (vrijednostStavke + udioTroskova) / kolicina;

      const robaRes = await client.query('SELECT sifra, naziv FROM roba WHERE id=$1', [s.roba_id]);
      if (!robaRes.rows.length) continue;

      await client.query(
        `INSERT INTO kalkulacija_stavke (kalkulacija_id, roba_id, sifra, naziv, kolicina, nabavna_cijena, udio_troskova, prava_nabavna_cijena, prodajna_cijena)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [kalkulacijaId, s.roba_id, robaRes.rows[0].sifra, robaRes.rows[0].naziv, kolicina, nabavnaCijena, udioTroskova, pravaNabavnaCijena, prodajnaCijena]
      );

      // Uvećaj stanje, postavi novu prodajnu cijenu i pravu nabavnu cijenu za taj PJ.
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

      // Zabilježi u roba_kretanja — isti "tip" sistem koji već koristi kartica artikla
      // (vidi GET /api/roba/:id/kartica), da se kalkulacija odmah pojavi u istoriji.
      await client.query(
        `INSERT INTO roba_kretanja (roba_id, objekt_id, tip, kolicina, cijena_stara, cijena_nova, napomena, korisnik_id, korisnik_ime)
         VALUES ($1,$2,'kalkulacija',$3,NULL,$4,$5,$6,$7)`,
        [s.roba_id, objekt_id, kolicina, pravaNabavnaCijena,
         `Kalkulacija #${kalkulacijaId} — ${dobavljac.trim()}${broj ? ' (' + broj + ')' : ''}`, user.id, user.ime_prezime]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, id: kalkulacijaId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
