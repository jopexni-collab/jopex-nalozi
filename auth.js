const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('./db');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email i lozinka su obavezni.' });
  try {
    const r = await pool.query(
      `SELECT id, ime_prezime, email, lozinka, rola, aktivan,
              moze_ugovarati, unos_naloga, izmjena_statusa, izmjena_naloga,
              moze_prodavati, moze_roba_magacin, blagajnik_objekat_id
       FROM zaposleni WHERE LOWER(email) = LOWER($1)`,
      [String(email).trim()]
    );
    if (!r.rows.length)
      return res.status(401).json({ error: 'Pogrešan email ili lozinka.' });
    const user = r.rows[0];
    if (!user.aktivan)
      return res.status(403).json({ error: 'Nalog je deaktiviran.' });
    const ok = await bcrypt.compare(password, user.lozinka || '');
    if (!ok)
      return res.status(401).json({ error: 'Pogrešan email ili lozinka.' });

    // Da li je osoba blagajnik za bar jedan PJ (many-to-many tabela — ne stari
    // blagajnik_objekat_id koji se više ne koristi za ovu provjeru).
    const bR = await pool.query('SELECT 1 FROM blagajnici_pj WHERE zaposleni_id=$1 LIMIT 1', [user.id]);
    const jeBlagajnik = bR.rows.length > 0;

    req.session.user = {
      id: user.id,
      ime_prezime: user.ime_prezime,
      email: user.email,
      rola: user.rola,
      moze_ugovarati: user.moze_ugovarati,
      unos_naloga: user.unos_naloga,
      izmjena_statusa: user.izmjena_statusa,
      izmjena_naloga: user.izmjena_naloga,
      moze_prodavati: user.moze_prodavati,
      moze_roba_magacin: user.moze_roba_magacin,
      blagajnik_objekat_id: user.blagajnik_objekat_id,
      je_blagajnik: jeBlagajnik,
    };

    // Trajna istorija prijava (van glavne sesijske tabele, koja pamti samo trenutno
    // aktivne) — ne blokira prijavu ako ovo iz nekog razloga padne.
    pool.query(
      `INSERT INTO prijave_log (zaposleni_id, ime_prezime, email, ip) VALUES ($1,$2,$3,$4)`,
      [user.id, user.ime_prezime, user.email, req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null]
    ).catch(e => console.error('Greška pri upisu prijave_log:', e.message));

    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri prijavi.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session?.user)
    return res.status(401).json({ error: 'Niste prijavljeni.' });
  res.json(req.session.user);
});

// GET /api/auth/prijave - SAMO admin - istorija prijava (poslednjih 200)
router.get('/prijave', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin.' });
  try {
    const r = await pool.query(
      `SELECT id, ime_prezime, email, ip, prijavljen FROM prijave_log ORDER BY prijavljen DESC LIMIT 200`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/aktivni - SAMO admin - trenutno aktivne sesije (neistekle). Izvedeno iz
// "session" tabele (connect-pg-simple) — nije 100% "otvoren tab upravo sad", nego "ima
// važeći login cookie", ali je dovoljno dobra aproksimacija za nadzor.
router.get('/aktivni', async (req, res) => {
  if (req.session?.user?.rola !== 'admin')
    return res.status(403).json({ error: 'Samo admin.' });
  try {
    const r = await pool.query(
      `SELECT sid, sess, expire FROM session WHERE expire > now() ORDER BY expire DESC`
    );
    const aktivni = r.rows
      .map(row => {
        const u = row.sess?.user;
        if (!u) return null;
        return { id: u.id, ime_prezime: u.ime_prezime, email: u.email, rola: u.rola, istice: row.expire };
      })
      .filter(Boolean);
    // Jedan zaposleni može imati više aktivnih sesija (npr. telefon + računar) — spoji
    // po id-u, zadrži samo najkasniji "ističe" datum za pregled.
    const poKorisniku = {};
    for (const a of aktivni) {
      if (!poKorisniku[a.id] || a.istice > poKorisniku[a.id].istice) poKorisniku[a.id] = a;
    }
    res.json(Object.values(poKorisniku));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// mijenjanja sesije. Koristi se kao dodatna provjera na osjetljivim mjestima (npr. izbor
// prodajnog objekta u maloprodaji) — da neko slučajno ili namjerno ne generiše prodaju na
// pogrešnom PJ samo zato što je uređaj već ulogovan.
router.post('/verify-password', async (req, res) => {
  if (!req.session?.user)
    return res.status(401).json({ error: 'Niste prijavljeni.' });
  const { password } = req.body || {};
  if (!password)
    return res.status(400).json({ error: 'Unesite lozinku.' });
  try {
    const r = await pool.query('SELECT lozinka FROM zaposleni WHERE id=$1', [req.session.user.id]);
    if (!r.rows.length)
      return res.status(401).json({ error: 'Nalog nije pronađen.' });
    const ok = await bcrypt.compare(password, r.rows[0].lozinka || '');
    if (!ok)
      return res.status(401).json({ error: 'Pogrešna lozinka.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri provjeri.' });
  }
});

module.exports = router;
