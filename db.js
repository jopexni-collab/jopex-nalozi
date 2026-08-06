require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('GREŠKA: DATABASE_URL nije postavljen u .env fajlu.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ||
       process.env.DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
  // Podrazumevani max je SAMO 10 — premalo za nekoliko ISTOVREMENIH korisnika kad neke
  // rute (npr. "Klijenti finansije") sad paralelno šalju više upita odjednom (Promise.all)
  // radi brzine. Bez ovoga, dva korisnika u istom trenutku mogu iscrpiti pool i praviti
  // čekanja/greške umjesto da se stvarno ubrza.
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', err => console.error('Greška na bazi:', err.message));
module.exports = pool;
