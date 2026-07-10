// server.js
require('dotenv').config();
const express    = require('express');
const path       = require('path');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const pool       = require('./db');
const requireLogin = require('./requireLogin');

const app = express();

app.use(express.json({ limit: '2mb' })); // 2mb - dovoljno i za veće ponude
app.use(express.urlencoded({ extended: false }));

// CORS - JoPeX HTML radi kao lokalni fajl (file://) i šalje zahtjeve ovom
// serveru. Dozvoljavamo sve izvore u razvoju; u produkciji (kad je server na
// webu) browser prihvata sve jer je JoPeX HTML servan sa istog servera.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Sesije u bazi (session tabela se pravi automatski)
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
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dana
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  },
}));

// ─── Javne rute (bez prijave) ─────────────────────────────────────────────
app.use('/api/auth',   require('./auth'));
// /api/config je javna da JoPeX HTML može povući materijale/kupce/obrade
// i bez prijave (offline-first: keširaj pa koristi kad nema interneta)
app.use('/api/config', require('./config'));

// ─── Zaštićene rute (trebaju prijavu) ────────────────────────────────────
app.use('/api/zaposleni',   requireLogin, require('./zaposleni'));
app.use('/api/proizvodnja', requireLogin, require('./proizvodnja'));

// ─── Statički fajlovi (web aplikacija) ───────────────────────────────────
app.use(express.static(__dirname));

// Zdravstvena provjera - koristi se za monitoring i za JoPeX da provjeri
// da li je server dostupan prije slanja naloga
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
