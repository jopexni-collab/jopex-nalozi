const express = require('express');
const router = express.Router();
const pool = require('./db');

// Provjera da li je korisnik blagajnik ZA KONKRETAN PJ (ili admin, koji prolazi svugdje).
function jeBlagajnikZaObjekat(user, objektId) {
  if (user?.rola === 'admin') return true;
  return user?.blagajnik_objekat_id != null && String(user.blagajnik_objekat_id) === String(objektId);
}

// GET /api/blagajna-razduzenja?objekt_id=X&status=Y - lista razduženja
router.get('/', async (req, res) => {
  try {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
    const { objekt_id, status } = req.query;

    // Blagajnik vidi SAMO svoj PJ; admin vidi sve (ili filtrira po objekt_id ako izabere).
    let where = [];
    let vals = [];
    let i = 1;
    if (user.rola !== 'admin') {
      if (!user.blagajnik_objekat_id) return res.status(403).json({ error: 'Nemate ovlašćenje blagajnika.' });
      where.push(`objekt_id = $${i++}`); vals.push(user.blagajnik_objekat_id);
    } else if (objekt_id) {
      where.push(`objekt_id = $${i++}`); vals.push(objekt_id);
    }
    if (status) { where.push(`status = $${i++}`); vals.push(status); }

    const sql = `SELECT * FROM blagajna_razduzenja
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY kreirano DESC LIMIT 200`;
    const r = await pool.query(sql, vals);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/blagajna-razduzenja/stanje?objekt_id=X - trenutno "u blagajni" za taj PJ
// = sve što je predano blagajniku (gotovina.predao_blagajniku=true) MINUS sve što je
// razduženo (bez obzira da li je admin već potvrdio — fizički je novac već izašao iz
// kase čim ga blagajnik uzme).
router.get('/stanje', async (req, res) => {
  try {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
    const objektId = req.query.objekt_id || user.blagajnik_objekat_id;
    if (!objektId) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
    if (!jeBlagajnikZaObjekat(user, objektId)) return res.status(403).json({ error: 'Nemate pristup ovom PJ.' });

    const objRes = await pool.query('SELECT naziv FROM prodajni_objekti WHERE id=$1', [objektId]);
    if (!objRes.rows.length) return res.status(404).json({ error: 'Prodajni objekat nije pronađen.' });
    const objektNaziv = objRes.rows[0].naziv;

    const predanoRes = await pool.query(
      `SELECT COALESCE(SUM(iznos),0) AS ukupno FROM gotovina
       WHERE objekt_naziv = $1 AND predao_blagajniku = true`,
      [objektNaziv]
    );
    const razduzenoRes = await pool.query(
      `SELECT COALESCE(SUM(iznos),0) AS ukupno FROM blagajna_razduzenja WHERE objekt_id=$1`,
      [objektId]
    );
    const predano = parseFloat(predanoRes.rows[0].ukupno);
    const razduzeno = parseFloat(razduzenoRes.rows[0].ukupno);
    res.json({ objekt_naziv: objektNaziv, predano, razduzeno, trenutno_u_blagajni: +(predano - razduzeno).toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/blagajna-razduzenja - blagajnik bilježi novo razduženje (banka ili sef)
// body: { objekt_id, tip, iznos, napomena }
router.post('/', async (req, res) => {
  try {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'Morate biti prijavljeni.' });
    const { objekt_id, tip, napomena } = req.body;
    const iznos = parseFloat(req.body.iznos);

    if (!objekt_id) return res.status(400).json({ error: 'Nedostaje prodajni objekat.' });
    if (!jeBlagajnikZaObjekat(user, objekt_id)) return res.status(403).json({ error: 'Nemate ovlašćenje blagajnika za ovaj PJ.' });
    if (!['banka', 'sef'].includes(tip)) return res.status(400).json({ error: 'Tip mora biti "banka" ili "sef".' });
    if (!iznos || iznos <= 0) return res.status(400).json({ error: 'Unesite ispravan iznos.' });

    const objRes = await pool.query('SELECT naziv FROM prodajni_objekti WHERE id=$1', [objekt_id]);
    if (!objRes.rows.length) return res.status(404).json({ error: 'Prodajni objekat nije pronađen.' });
    const objektNaziv = objRes.rows[0].naziv;

    // Provjeri da ne razdužuje više nego što stvarno ima u blagajni.
    const predanoRes = await pool.query(
      `SELECT COALESCE(SUM(iznos),0) AS ukupno FROM gotovina WHERE objekt_naziv=$1 AND predao_blagajniku=true`,
      [objektNaziv]
    );
    const razduzenoRes = await pool.query(
      `SELECT COALESCE(SUM(iznos),0) AS ukupno FROM blagajna_razduzenja WHERE objekt_id=$1`,
      [objekt_id]
    );
    const trenutno = parseFloat(predanoRes.rows[0].ukupno) - parseFloat(razduzenoRes.rows[0].ukupno);
    if (iznos > trenutno + 0.01)
      return res.status(400).json({ error: `Nema dovoljno u blagajni (trenutno: ${trenutno.toFixed(2)} KM).` });

    const r = await pool.query(
      `INSERT INTO blagajna_razduzenja (objekt_id, objekt_naziv, tip, iznos, napomena, blagajnik_id, blagajnik_ime)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [objekt_id, objektNaziv, tip, iznos, napomena || null, user.id, user.ime_prezime]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/blagajna-razduzenja/:id/potvrdi - SAMO admin, nakon provjere (npr. uparivanje
// sa bankovnom uplatnicom ili fizička provjera sadržaja sefa).
router.post('/:id/potvrdi', async (req, res) => {
  try {
    const user = req.session?.user;
    if (user?.rola !== 'admin') return res.status(403).json({ error: 'Samo admin može potvrditi razduženje.' });
    const r = await pool.query(
      `UPDATE blagajna_razduzenja SET status='potvrdjeno', potvrdio_admin_id=$1, potvrdio_admin_ime=$2, datum_potvrde=now()
       WHERE id=$3 AND status='na_cekanju' RETURNING *`,
      [user.id, user.ime_prezime, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Razduženje nije pronađeno ili je već potvrđeno.' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
