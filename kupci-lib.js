// kupci-lib.js
// Zajednička logika za "kupci" tabelu. Koriste je DVA odvojena API ulaza:
//   - config.js  (/api/config/kupci) — javno, bez logina, koristi radni nalozi
//   - kupci.js   (/api/kupci)        — sa proverom prava, koristi maloprodaja
// Ideja: jedno mjesto koje zna sva polja (uključujući "grad" i "napomena"),
// da oba sistema uvijek vide/pišu istu šemu na isti način, bez razmimoilaženja.
// Auth pravila ostaju u svakoj ruti posebno (namjerno — različiti su razlozi
// za javni vs. zaštićeni pristup), ovdje je samo pristup bazi.
const pool = require('./db');

// Sva polja kupca koja se mogu upisati/mijenjati preko ove biblioteke.
const POLJA = ['naziv', 'telefon', 'grad', 'adresa', 'email', 'napomena', 'tipovi'];

// Lista kupaca — bez pretrage, cijela tabela (ili samo aktivni). Koristi admin
// pregled u config.js (samoAktivni:false, da se vide i neaktivni za reaktivaciju)
// i offline-cache dio istog fajla (samoAktivni:true).
async function listaKupaca({ samoAktivni = false } = {}) {
  const where = samoAktivni ? 'WHERE aktivan = true' : '';
  const r = await pool.query(`SELECT * FROM kupci ${where} ORDER BY naziv`);
  return r.rows;
}

// Pretraga uživo (za POS-stil brzu pretragu dok se kuca) — koristi maloprodaja.
async function pretraziKupce(q, limit) {
  const lim = Math.min(parseInt(limit) || 20, 50);
  if (!q || !q.trim()) {
    const r = await pool.query(
      `SELECT * FROM kupci WHERE aktivan IS NOT FALSE ORDER BY kreiran DESC LIMIT $1`, [lim]
    );
    return r.rows;
  }
  const term = q.trim();
  const r = await pool.query(
    `SELECT * FROM kupci
     WHERE aktivan IS NOT FALSE AND (naziv ILIKE $1 OR telefon ILIKE $1)
     ORDER BY (naziv ILIKE $2) DESC, naziv
     LIMIT $3`,
    [`%${term}%`, `${term}%`, lim]
  );
  return r.rows;
}

async function kreirajKupca(podaci) {
  const naziv = (podaci.naziv || '').trim();
  if (!naziv) throw Object.assign(new Error('Naziv/ime kupca je obavezno.'), { status: 400 });
  const tipovi = Array.isArray(podaci.tipovi) && podaci.tipovi.length ? podaci.tipovi : null;
  const r = await pool.query(
    `INSERT INTO kupci (naziv, telefon, grad, adresa, email, napomena, tipovi)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [naziv, podaci.telefon || null, podaci.grad || null, podaci.adresa || null,
     podaci.email || null, podaci.napomena || null, tipovi]
  );
  return r.rows[0];
}

async function azurirajKupca(id, podaci) {
  const tipovi = Array.isArray(podaci.tipovi) ? podaci.tipovi : undefined;
  const r = await pool.query(
    `UPDATE kupci SET
       naziv    = COALESCE($1, naziv),
       telefon  = COALESCE($2, telefon),
       grad     = COALESCE($3, grad),
       adresa   = COALESCE($4, adresa),
       email    = COALESCE($5, email),
       napomena = COALESCE($6, napomena),
       aktivan  = COALESCE($7, aktivan),
       tipovi   = COALESCE($8, tipovi)
     WHERE id = $9 RETURNING *`,
    [podaci.naziv, podaci.telefon, podaci.grad, podaci.adresa,
     podaci.email, podaci.napomena, podaci.aktivan, tipovi, id]
  );
  return r.rows[0] || null;
}

module.exports = { POLJA, listaKupaca, pretraziKupce, kreirajKupca, azurirajKupca };
