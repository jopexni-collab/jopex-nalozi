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
app.use(express.json({ limit: '2mb' }));
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
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  },
}));
function requireLoginOrApiKey(req, res, next) {
  if (req.session && req.session.user) return next();
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey && apiKey === process.env.API_KEY) {
    req.session = req.session || {};
    req.session.user = { rola: 'admin', ime_prezime: 'JoPeX' };
    return next();
  }
  return res.status(401).json({ error: 'Morate biti prijavljeni.' });
}
// ─── Javne rute ───────────────────────────────────────────────────────────
app.use('/api/auth',   require('./auth'));
app.use('/api/config', require('./config'));
app.use('/api/otpremnice-javno', require('./otpremnice-javno'));
// ─── Zaštićene rute ───────────────────────────────────────────────────────
app.use('/api/upload',     requireLoginOrApiKey, require('./upload'));
app.use('/api/zaposleni',   requireLoginOrApiKey, require('./zaposleni'));
app.use('/api/proizvodnja', requireLoginOrApiKey, require('./proizvodnja'));
app.use('/api/gotovina',    requireLoginOrApiKey, require('./gotovina'));
app.use('/api/roba',        requireLoginOrApiKey, require('./roba'));
app.use('/api/otpremnice',  requireLoginOrApiKey, require('./otpremnice'));
app.use('/api/kupci',       requireLoginOrApiKey, require('./kupci'));
app.use('/api/ponude',      requireLoginOrApiKey, require('./ponude'));
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
