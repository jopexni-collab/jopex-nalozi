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
app.use('/api/isplate-javno', require('./isplate-javno'));
app.use('/api/uplate-javno', require('./uplate-javno'));
// ─── Zaštićene rute ───────────────────────────────────────────────────────
app.use('/api/upload',     requireLoginOrApiKey, require('./upload'));
app.use('/api/zaposleni',   requireLoginOrApiKey, require('./zaposleni'));
app.use('/api/proizvodnja', requireLoginOrApiKey, require('./proizvodnja'));
app.use('/api/gotovina',    requireLoginOrApiKey, require('./gotovina'));
app.use('/api/roba',        requireLoginOrApiKey, require('./roba'));
const otpremniceRouter = require('./otpremnice');
app.use('/api/otpremnice',  requireLoginOrApiKey, otpremniceRouter);
app.use('/api/kupci',       requireLoginOrApiKey, require('./kupci'));
app.use('/api/ponude',      requireLoginOrApiKey, require('./ponude'));
app.use('/api/prodajni-objekti', requireLoginOrApiKey, require('./prodajni-objekti'));
app.use('/api/prenosi', requireLoginOrApiKey, require('./prenosi'));
app.use('/api/isplate', requireLoginOrApiKey, require('./isplate'));
app.use('/api/uplate', requireLoginOrApiKey, require('./uplate'));
app.use('/api/blagajna-razduzenja', requireLoginOrApiKey, require('./blagajna-razduzenja'));
// ─── Statički fajlovi ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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
