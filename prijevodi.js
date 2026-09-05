// prijevodi.js — RJEČNIK PRIJEVODA za katalog na stranom jeziku
//
// Baza i unos ostaju na našem jeziku. Prijevod se traži TEK pri pravljenju kataloga,
// iz ovog rječnika. Ono što nije prevedeno ostaje kako jeste — katalog nikad ne ostaje
// prazan zbog toga.
//
// Rječnik se puni ručno ili grupno; mjesto za vanjski servis je pripremljeno, ali se
// ne koristi bez ključa.

const express = require('express');
const router = express.Router();
const pool = require('./db');

const JEZICI = ['en', 'it', 'de', 'fr'];

router.use((req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Niste prijavljeni.' });
  next();
});

function smije(req) {
  const u = req.session?.user;
  return u?.rola === 'admin' || u?.moze_roba_magacin;
}

/* GET / — svi prijevodi, poredani po izvornom tekstu */
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT izvor,
              json_object_agg(jezik, prijevod) AS prijevodi,
              bool_or(automatski) AS ima_automatskih
       FROM prijevodi GROUP BY izvor ORDER BY izvor`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /nedostaju — tekst koji ide u katalog a nije preveden.
   Skuplja se sa mjesta koja katalog stvarno prikazuje, da se ne prevodi uzalud. */
router.get('/nedostaju', async (req, res) => {
  const jezik = JEZICI.includes(req.query.jezik) ? req.query.jezik : 'en';
  try {
    const r = await pool.query(
      `WITH izvori AS (
         SELECT DISTINCT naziv AS t FROM grupe_proizvoda WHERE aktivan = true
         UNION SELECT DISTINCT naziv FROM gotovi_proizvodi WHERE aktivan = true
         UNION SELECT DISTINCT naziv FROM grupa_sastojci
         UNION SELECT DISTINCT TRIM(grupa) FROM roba
                WHERE aktivan = true AND COALESCE(TRIM(grupa),'') <> ''
       )
       SELECT i.t AS izvor
       FROM izvori i
       LEFT JOIN prijevodi p ON lower(p.izvor) = lower(i.t) AND p.jezik = $1
       WHERE p.id IS NULL AND COALESCE(TRIM(i.t),'') <> ''
       ORDER BY i.t`,
      [jezik]
    );
    res.json({ jezik, nedostaju: r.rows.map(x => x.izvor) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST / — upis jednog ili više prijevoda */
router.post('/', async (req, res) => {
  if (!smije(req)) return res.status(403).json({ error: 'Nemate dozvolu.' });
  const stavke = Array.isArray(req.body?.stavke) ? req.body.stavke : [req.body];
  const u = req.session.user;
  let upisano = 0;
  try {
    for (const s of stavke) {
      const izvor = String(s?.izvor || '').trim();
      const jezik = JEZICI.includes(s?.jezik) ? s.jezik : null;
      const prijevod = String(s?.prijevod || '').trim();
      if (!izvor || !jezik) continue;

      if (!prijevod) {
        // Prazan prijevod znaci "obrisi" — inace bi ostao stari, pogresan
        await pool.query('DELETE FROM prijevodi WHERE lower(izvor)=lower($1) AND jezik=$2', [izvor, jezik]);
        continue;
      }
      await pool.query(
        `INSERT INTO prijevodi (izvor, jezik, prijevod, automatski, ko)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (lower(izvor), jezik)
         DO UPDATE SET prijevod = EXCLUDED.prijevod, automatski = EXCLUDED.automatski,
                       kada = now(), ko = EXCLUDED.ko`,
        [izvor, jezik, prijevod, s?.automatski === true, u.ime_prezime]
      );
      upisano++;
    }
    res.json({ ok: true, upisano });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Prijevod za katalog — jedan poziv, sve odjednom.
   Vraca mapu {izvorni_tekst: prijevod} za trazeni jezik. */
async function mapaPrijevoda(jezik) {
  if (!JEZICI.includes(jezik)) return {};
  const r = await pool.query('SELECT izvor, prijevod FROM prijevodi WHERE jezik=$1', [jezik]);
  const m = {};
  for (const x of r.rows) m[String(x.izvor).toLowerCase()] = x.prijevod;
  return m;
}

module.exports = router;
module.exports.mapaPrijevoda = mapaPrijevoda;
