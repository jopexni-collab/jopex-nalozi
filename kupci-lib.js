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
// grupaId (opciono): ako je proslijeđen, filtrira na kupce IZ TE grupe ILI bez grupe
// (grupa_id IS NULL — stari, još neraspoređeni kupci, privremeno vidljivi svima dok
// se ručno ne razvrstaju). Bez grupaId (npr. stariji pozivi koji ga ne šalju), vraća
// SVE — ponašanje ostaje nepromijenjeno za mjesta koja ovo još ne koriste.
async function pretraziKupce(q, limit, grupaId) {
  const lim = Math.min(parseInt(limit) || 20, 50);
  const grupaUslov = grupaId ? `AND (grupa_id = $GRUPA OR grupa_id IS NULL)` : '';
  if (!q || !q.trim()) {
    const sql = `SELECT * FROM kupci WHERE aktivan IS NOT FALSE ${grupaUslov.replace('$GRUPA', '$2')}
                 ORDER BY kreiran DESC LIMIT $1`;
    const vals = grupaId ? [lim, grupaId] : [lim];
    const r = await pool.query(sql, vals);
    return r.rows;
  }
  const term = q.trim();
  const sql = `SELECT * FROM kupci
     WHERE aktivan IS NOT FALSE AND (naziv ILIKE $1 OR telefon ILIKE $1)
     ${grupaUslov.replace('$GRUPA', '$4')}
     ORDER BY (naziv ILIKE $2) DESC, naziv
     LIMIT $3`;
  const vals = grupaId ? [`%${term}%`, `${term}%`, lim, grupaId] : [`%${term}%`, `${term}%`, lim];
  const r = await pool.query(sql, vals);
  return r.rows;
}

async function kreirajKupca(podaci) {
  const naziv = (podaci.naziv || '').trim();
  if (!naziv) throw Object.assign(new Error('Naziv/ime kupca je obavezno.'), { status: 400 });
  const tipovi = Array.isArray(podaci.tipovi) && podaci.tipovi.length ? podaci.tipovi : null;
  const r = await pool.query(
    `INSERT INTO kupci (naziv, telefon, grad, adresa, email, napomena, tipovi, grupa_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [naziv, podaci.telefon || null, podaci.grad || null, podaci.adresa || null,
     podaci.email || null, podaci.napomena || null, tipovi, podaci.grupa_id || null]
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
       tipovi   = COALESCE($8, tipovi),
       grupa_id = COALESCE($10, grupa_id)
     WHERE id = $9 RETURNING *`,
    [podaci.naziv, podaci.telefon, podaci.grad, podaci.adresa,
     podaci.email, podaci.napomena, podaci.aktivan, tipovi, id, podaci.grupa_id]
  );
  return r.rows[0] || null;
}

module.exports = { POLJA, listaKupaca, pretraziKupce, kreirajKupca, azurirajKupca };
