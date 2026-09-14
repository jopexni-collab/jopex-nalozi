/* restl-alert.js — indikator odobrenja u glavnoj traci.
 *
 * Uključuje se jednom linijom u bilo koju stranicu:
 *     <script src="restl-alert.js"></script>
 *
 * Sam pronađe <header>, doda zvonce sa brojem stavki na čekanju i osvježava ga.
 * Ne traži nikakve izmjene u samoj stranici i ne dira ništa postojeće — ako nešto
 * ne uspije, tiho odustane umjesto da obori stranicu.
 */
(function () {
  'use strict';

  const OSVJEZI_MS = 60000;      // jednom u minuti — češće bi bilo bespotrebno
  const PUTANJA = '/api/restlovi/odobrenja';
  let zadnjiBroj = -1;

  function nadjiTraku() {
    // Prvo <header>, pa uobičajene klase zaglavlja u ovoj aplikaciji
    return document.querySelector('header') ||
           document.querySelector('.topbar, .header, .app-header, nav');
  }

  function napraviZvonce(traka) {
    let el = document.getElementById('restl-alert');
    if (el) return el;

    el = document.createElement('a');
    el.id = 'restl-alert';
    el.href = 'restlovi.html?tab=odobrenja';
    el.title = 'Odobrenja materijala';
    el.style.cssText =
      'display:none;align-items:center;gap:5px;padding:4px 9px;border-radius:14px;' +
      'background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.45);' +
      'color:#fff;text-decoration:none;font-size:12px;font-weight:700;cursor:pointer;' +
      'white-space:nowrap;margin-left:8px;';

    // Ubacuje se u navigaciju ako postoji, inače na kraj trake
    const nav = traka.querySelector('nav') || traka;
    nav.appendChild(el);
    return el;
  }

  function prikazi(el, broj, detalji) {
    if (!broj) { el.style.display = 'none'; return; }
    el.style.display = 'inline-flex';
    el.innerHTML = '🔔 <span style="background:#c0392b;color:#fff;border-radius:9px;' +
      'padding:1px 7px;font-size:11px">' + broj + '</span>' +
      '<span style="opacity:.9">na odobrenje</span>';
    el.title = detalji;

    // Kratko zatreperi SAMO kad broj poraste — inače bi svako osvježavanje
    // skretalo pažnju na nešto što je korisnik već vidio.
    if (zadnjiBroj >= 0 && broj > zadnjiBroj) {
      el.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }],
        { duration: 500, iterations: 2 });
    }
    zadnjiBroj = broj;
  }

  async function provjeri() {
    const traka = nadjiTraku();
    if (!traka) return;
    try {
      const r = await fetch(PUTANJA, { credentials: 'include' });
      if (!r.ok) return;                       // nije prijavljen ili nema pravo
      const d = await r.json();
      if (!d.smijem) return;                   // ne odobrava — zvonce se ne prikazuje
      const el = napraviZvonce(traka);
      const opis = [
        d.trebovanja && d.trebovanja.length ? d.trebovanja.length + ' trebovanja materijala' : null,
        d.povrati && d.povrati.length ? d.povrati.length + ' povrata restlova' : null,
      ].filter(Boolean).join(' · ');
      prikazi(el, d.ukupno || 0, opis || 'Odobrenja materijala');
    } catch (e) { /* bez mreže se ništa ne prikazuje */ }
  }

  function pokreni() {
    provjeri();
    setInterval(provjeri, OSVJEZI_MS);
    // Kad se korisnik vrati na karticu, odmah provjeri — u međuvremenu se moglo
    // pojaviti nešto novo, a čekanje do sljedeće minute bi bilo predugo.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) provjeri();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pokreni);
  } else {
    pokreni();
  }
})();
