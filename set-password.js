// set-password.js
// Upotreba: node set-password.js email@firma.com NovaLozinka123
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool   = require('./db');

async function main() {
  const [,,email, password] = process.argv;
  if (!email || !password) {
    console.error('Upotreba: node set-password.js email@firma.com NovaLozinka');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('Lozinka mora imati bar 6 karaktera.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `UPDATE zaposleni SET lozinka = $1 WHERE LOWER(email) = LOWER($2)
     RETURNING id, ime_prezime, email`,
    [hash, email.trim()]
  );
  if (!r.rows.length) {
    console.error(`Nije pronađen zaposleni sa email-om "${email}".`);
    console.error('Provjeri email u zaposleni tabeli (pgAdmin: SELECT email FROM zaposleni;)');
  } else {
    console.log(`✓ Lozinka postavljena za: ${r.rows[0].ime_prezime} (${r.rows[0].email})`);
  }
  await pool.end();
}
main().catch(err => { console.error(err.message); process.exit(1); });
