// email.js
// Dijeljeni helper za slanje emailova sa servera (za razliku od Viber/WhatsApp/mailto
// dugmadi koja samo otvaraju korisnikov email klijent — ovo STVARNO šalje email, bez
// da korisnik ima otvoren svoj email program).
//
// KONFIGURACIJA (Railway → Variables, obavezno postaviti da bi slanje radilo):
//   SMTP_HOST     - npr. smtp.gmail.com
//   SMTP_PORT     - npr. 587
//   SMTP_USER     - email nalog sa kog se šalje
//   SMTP_PASS     - lozinka / app password tog naloga
//   SMTP_FROM     - (opciono) "JoPeX <noreply@jopex.ba>" — ako nije postavljeno, koristi SMTP_USER
//
// Ako SMTP_HOST/USER/PASS nisu postavljeni, slanje se PRESKAČE (ne ruši aplikaciju) —
// samo se upiše upozorenje u log, da razvoj/testiranje bez email podešavanja ne puca.

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  console.warn('⚠ nodemailer nije instaliran — email slanje neće raditi. Pokreni: npm install nodemailer');
}

function konfigurisan() {
  return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!konfigurisan()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

// posaljiEmail(to, subject, html) -> { ok: true } | { ok: false, error }
// Nikad ne baca grešku — vraća rezultat, poziva se odgovorno (ne blokira glavni tok,
// npr. potvrdu otpremnice, ako email padne).
async function posaljiEmail(to, subject, html) {
  if (!to) return { ok: false, error: 'Nedostaje email adresa primaoca.' };
  const t = getTransporter();
  if (!t) return { ok: false, error: 'Email slanje nije konfigurisano (SMTP_HOST/SMTP_USER/SMTP_PASS).' };
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, html,
    });
    return { ok: true };
  } catch (err) {
    console.error('Greška pri slanju emaila:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { posaljiEmail, konfigurisan };
