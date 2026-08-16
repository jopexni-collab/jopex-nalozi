// server.js
// server.js - updated 2026-07-17
require('dotenv').config();
const express    = require('express');
const path       = require('path');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const pool       = require('./db');
const requireLogin = require('./requireLogin');
const app = express();
// Iza reverse proxy-ja (nginx, itd.) — bez ovoga Express NE VJERUJE zaglavlju
// X-Forwarded-Proto koje nginx šalje, pa "misli" da je konekcija HTTP čak i kad je
// stvarna konekcija (klijent → nginx) HTTPS. To može praviti probleme sa "secure"
// kolačićem i drugom logikom koja zavisi od req.protocol/req.secure.
app.set('trust proxy', 1);
app.use(express.json({ limit: '15mb' })); // slike sa telefona (base64) lako prelaze 2mb
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'jopex-promijeni-u-produkciji',
  resave: false,
  saveUninitialized: false,
  rolling: true, // svaki zahtjev produžava sesiju — automatska odjava tek posle 30 min
                 // BEZ ijednog zahtjeva servera (uključujući pozadinsko osvježavanje)
  cookie: {
    maxAge: 30 * 60 * 1000, // 30 minuta neaktivnosti
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // eksplicitno postavljeno — bez ovoga browser koristi svoj default,
                      // što ponekad pravi probleme kod redirect tokova iza reverse proxy-ja
  },
}));
function requireLoginOrApiKey(req, res, next) {
  if (req.session && req.session.user) return next();
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey && apiKey === process.env.API_KEY) {
    req.session = req.session || {};
    req.session.user = { rola: 'admin', ime_prezime: 'JoPeX', izAPIKljuca: true };
    return next();
  }
  return res.status(401).json({ error: 'Morate biti prijavljeni.' });
}
// ─── Javne rute ───────────────────────────────────────────────────────────
app.use('/api/auth',   require('./auth'));
app.use('/api/config', require('./config'));
app.use('/api/otpremnice-javno', require('./otpremnice-javno'));
app.use('/api/terenske-ponude-javno', require('./terenske-ponude-javno'));
app.use('/api/isplate-javno', require('./isplate-javno'));
app.use('/api/katalog-javno', require('./katalog-javno'));
app.use('/api/uplate-javno', require('./uplate-javno'));
// ─── Trening mod ────────────────────────────────────────────────────────────
// Ako je korisnik u trening modu, SVAKI pokušaj upisa (POST/PATCH/PUT/DELETE) na bilo
// koju API rutu se zaustavlja OVDE, prije nego što stigne do bilo koje pojedinačne rute —
// centralizovano, tako da ne treba dirati svaku od desetina write-ruta pojedinačno (i ne
// postoji rizik da se neka od njih slučajno propusti). Čitanje (GET) prolazi normalno —
// korisnik u trening modu i dalje vidi pravu, stvarnu bazu, samo ne može ništa da promijeni.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/auth/')) return next(); // login/logout mora raditi i u trening modu
  if (req.session?.user?.trening_mod === true) {
    return res.status(423).json({
      error: '🎓 Trening mod je uključen — ovo je samo za vežbu, ništa se ne upisuje u pravu bazu.',
      trening_mod: true,
    });
  }
  next();
});

// ─── Zaštićene rute ───────────────────────────────────────────────────────
app.use('/api/upload',     requireLoginOrApiKey, require('./upload'));
app.use('/api/zaposleni',   requireLoginOrApiKey, require('./zaposleni'));
app.use('/api/proizvodnja', requireLoginOrApiKey, require('./proizvodnja'));
app.use('/api/gotovina',    requireLoginOrApiKey, require('./gotovina'));
app.use('/api/finansije',   requireLoginOrApiKey, require('./finansije'));
app.use('/api/plate',       requireLoginOrApiKey, require('./plate'));
app.use('/api/kalkulacije', requireLoginOrApiKey, require('./kalkulacije'));
app.use('/api/roba',        requireLoginOrApiKey, require('./roba'));
app.use('/api/cijene',      requireLoginOrApiKey, require('./cijene'));
app.use('/api/katalog',     requireLoginOrApiKey, require('./katalog'));
app.use('/api/analitika',   requireLoginOrApiKey, require('./analitika'));
const otpremniceRouter = require('./otpremnice');
app.use('/api/otpremnice',  requireLoginOrApiKey, otpremniceRouter);
app.use('/api/kupci',       requireLoginOrApiKey, require('./kupci'));
app.use('/api/ponude',      requireLoginOrApiKey, require('./ponude'));
app.use('/api/prodajni-objekti', requireLoginOrApiKey, require('./prodajni-objekti'));
app.use('/api/prenosi', requireLoginOrApiKey, require('./prenosi'));
app.use('/api/isplate', requireLoginOrApiKey, require('./isplate'));
app.use('/api/terenske-ponude', requireLoginOrApiKey, require('./terenske-ponude'));
app.use('/api/uplate', requireLoginOrApiKey, require('./uplate'));
app.use('/api/blagajna-razduzenja', requireLoginOrApiKey, require('./blagajna-razduzenja'));
// ─── Statički fajlovi ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    // Beleži KO je otvorio KOJU stranicu i KADA — samo za prijavljene korisnike, bez
    // blokiranja odgovora (fire-and-forget, ne čeka se upit u bazu).
    if (req.session?.user && req.session.user.id) {
      pool.query(
        `INSERT INTO stranica_posjete (korisnik_id, korisnik_ime, putanja) VALUES ($1,$2,$3)`,
        [req.session.user.id, req.session.user.ime_prezime, req.path]
      ).catch(() => {}); // greška u logovanju ne smije nikad srušiti stranicu
    }
  }
  next();
});
app.use(express.static(__dirname));
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});
const PORT = process.env.PORT || 3500;
app.listen(PORT, () => {
  console.log(`JoPeX server radi na http://localhost:${PORT}`);
  console.log(`  Zdravlje:  http://localhost:${PORT}/health`);
  console.log(`  Config:    http://localhost:${PORT}/api/config`);
  console.log(`  Web app:   http://localhost:${PORT}/login.html`);
});

// Dnevni zbirni pregled otpremnica za knjigovodstvo — provjerava se svakih 15 minuta;
// funkcija sama interno provjerava (kroz knjigovodstvo_dnevni_log) da li je već poslato
// danas za svaki PJ, tako da je bezbjedno da se ovo "okine" više puta zaredom (npr. posle
// restarta servera) — neće poslati duplo.
const SAT_DNEVNOG_PREGLEDA = 19; // 19:00 lokalno vrijeme servera
setInterval(() => {
  const sad = new Date();
  if (sad.getHours() >= SAT_DNEVNOG_PREGLEDA) {
    otpremniceRouter.posaljiDnevniPregled();
  }
}, 15 * 60 * 1000);
