// geometrija.js — rad sa proizvoljnim oblicima restla (pravougaonik, L, trapez, kosi rez).
//
// Oblik se čuva kao lista tjemena u milimetrima, u CAD orijentaciji (y raste NAGORE),
// obilazak u smjeru suprotnom od kazaljke. Pravougaonik i L se i dalje unose preko
// A/B/C/D, ali se ODMAH pretvaraju u tjemena — tako sve dalje (površina, provjera
// uklapanja, DXF) radi po JEDNOJ logici, bez posebnih slučajeva.

/* ── pretvaranje A/B/C/D u tjemena ── */
function tjemenaOdMjera(oblik, a, b, c, d) {
  const A = Number(a) || 0, B = Number(b) || 0;
  if (oblik === 'L') {
    const C = Number(c) || 0, D = Number(d) || 0;
    return [[0,0],[A,0],[A,B-D],[A-C,B-D],[A-C,B],[0,B]];
  }
  return [[0,0],[A,0],[A,B],[0,B]];
}

/* ── površina (Gaussova formula) u mm2, uvijek pozitivna ── */
function povrsinaPoligona(t) {
  let s = 0;
  for (let i = 0; i < t.length; i++) {
    const [x1,y1] = t[i], [x2,y2] = t[(i+1) % t.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/* ── granični pravougaonik ── */
function okvir(t) {
  const xs = t.map(p => p[0]), ys = t.map(p => p[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
    sirina: Math.max(...xs) - Math.min(...xs),
    visina: Math.max(...ys) - Math.min(...ys),
  };
}

/* ── da li je tačka unutar poligona (bacanje zraka) ── */
function tackaUnutra(t, x, y) {
  let unutra = false;
  for (let i = 0, j = t.length - 1; i < t.length; j = i++) {
    const [xi, yi] = t[i], [xj, yj] = t[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) unutra = !unutra;
  }
  return unutra;
}

/* ── udaljenost tačke od duži (za tačke koje leže NA ivici) ── */
function udaljenostOdDuzi(px, py, a, b) {
  const dx = b[0]-a[0], dy = b[1]-a[1];
  const duz2 = dx*dx + dy*dy;
  if (duz2 === 0) return Math.hypot(px-a[0], py-a[1]);
  let t = ((px-a[0])*dx + (py-a[1])*dy) / duz2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0]+t*dx), py - (a[1]+t*dy));
}

/* ── tačka je unutra ILI tačno na ivici ──
   Komad koji tačno ispuni restl (uglovi legnu na ivicu) MORA da prođe — inače bi
   aplikacija odbila savršeno poklapanje, što je najbolji mogući slučaj. */
function tackaUnutraIliNa(t, x, y, eps) {
  const e = eps === undefined ? 0.01 : eps;   // 0.01 mm
  if (tackaUnutra(t, x, y)) return true;
  for (let i = 0; i < t.length; i++) {
    if (udaljenostOdDuzi(x, y, t[i], t[(i+1) % t.length]) <= e) return true;
  }
  return false;
}

/* ── da li se dvije duži sijeku ── */
function duziSijeku(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0]-a[0]) * (c[1]-a[1]) - (b[1]-a[1]) * (c[0]-a[0]);
  const d1 = d(p3,p4,p1), d2 = d(p3,p4,p2), d3 = d(p1,p2,p3), d4 = d(p1,p2,p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/* ── da li pravougaonik w×h sa donjim lijevim uglom u (x,y) STAJE cijeli u poligon ──
   Uslov: sva četiri ugla unutra I nijedna stranica poligona ne presijeca stranicu
   pravougaonika. Za proste poligone je to dovoljno i tačno. */
function pravougaonikUnutra(t, x, y, w, h) {
  const uglovi = [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  for (const [ux, uy] of uglovi) if (!tackaUnutraIliNa(t, ux, uy)) return false;
  const sredina = [[x+w/2, y], [x+w, y+h/2], [x+w/2, y+h], [x, y+h/2], [x+w/2, y+h/2]];
  for (const [sx, sy] of sredina) if (!tackaUnutraIliNa(t, sx, sy)) return false;
  for (let i = 0; i < 4; i++) {
    const a = uglovi[i], b = uglovi[(i+1) % 4];
    for (let j = 0; j < t.length; j++) {
      if (duziSijeku(a, b, t[j], t[(j+1) % t.length])) return false;
    }
  }
  return true;
}

/* ── glavno pitanje: staje li komad w×h u ovaj oblik? ──
   Traži se po mreži položaja, u obje rotacije (0° i 90°). Mreža je NAMJERNO gruba
   (oko 24 koraka po osi) — brzina je važnija, a greška ide na SIGURNU stranu:
   može reći "ne staje" za komad koji bi uz mikro-pomjeranje stao, ali NIKAD neće
   reći "staje" za komad koji ne staje. Lažno "staje" bi značilo isječenu ploču. */
function komadStaje(t, w, h, rezerva) {
  const r = Number(rezerva) || 0;
  const W = Number(w) + r, H = Number(h) + r;
  const o = okvir(t);
  if (W <= 0 || H <= 0) return null;

  for (const [sw, sh] of [[W, H], [H, W]]) {
    if (sw > o.sirina + 0.001 || sh > o.visina + 0.001) continue;

    const rasponX = o.maxX - sw, rasponY = o.maxY - sh;
    const korakX = Math.max(1, (rasponX - o.minX) / 24);
    const korakY = Math.max(1, (rasponY - o.minY) / 24);

    // Kandidati: mreža + tačno poravnanje uz svako tjeme (tu su najčešća rješenja)
    const xs = new Set([o.minX, rasponX]);
    const ys = new Set([o.minY, rasponY]);
    for (let x = o.minX; x <= rasponX; x += korakX) xs.add(x);
    for (let y = o.minY; y <= rasponY; y += korakY) ys.add(y);
    for (const [px, py] of t) {
      if (px >= o.minX && px <= rasponX) xs.add(px);
      if (py >= o.minY && py <= rasponY) ys.add(py);
    }

    for (const x of xs) for (const y of ys) {
      if (pravougaonikUnutra(t, x, y, sw, sh)) {
        return { x, y, w: sw, h: sh, rotiran: sw !== W };
      }
    }
  }
  return null;
}

/* ── OBILAZAK PO STRANAMA ──
   Oblik se opisuje onako kako se mjeri na kamenu, bez ijednog stepena.

   Postoji zamišljena pravougaona mreža koja se okreće SAMO za 90° na svakom uglu.
   Svaka strana ima:
     duzina — koliko ide u smjeru mreže
     odmak  — koliko se DALJI kraj odmiče u stranu (0 = pravi ugao, sve drugo = kosi rez)
     smjer  — na koju stranu se skreće na kraju te strane ('L' ili 'D')

   Ključno: odmak pomjera samo tu stranu, a NE okreće mrežu. Zato poslije kosog reza
   sljedeći ugao ostaje pravi — baš kao na stvarnoj ploči. Trapez sa donjom 1200,
   gornjom 700 i visinom 600 je: A=1200, B=600 sa odmakom 500, C=700, D=600.

   Vraća i 'razmak' — koliko fali da se oblik zatvori. */
function tjemenaOdStrana(strane) {
  let x = 0, y = 0, mreza = 0;
  const t = [[0, 0]];
  const zaokr = v => Math.round(v * 100) / 100;
  for (let i = 0; i < strane.length; i++) {
    const L = Number(strane[i].duzina) || 0;
    const O = Number(strane[i].odmak) || 0;
    const a = mreza * Math.PI / 180, b = (mreza + 90) * Math.PI / 180;
    x += L * Math.cos(a) + O * Math.cos(b);
    y += L * Math.sin(a) + O * Math.sin(b);
    if (i < strane.length - 1) t.push([zaokr(x), zaokr(y)]);
    mreza += (strane[i].smjer === 'D' ? -90 : 90);
  }
  return { tjemena: t, razmak: Math.hypot(x, y) };
}

// Stvarna dužina strane (kod kosog reza je duža od unesene mjere po mreži)
function stvarnaDuzina(strana) {
  return Math.hypot(Number(strana.duzina) || 0, Number(strana.odmak) || 0);
}

/* ── zatvaranje oblika ── Ako oblik ne zatvara zbog sitne greške u mjerenju, posljednje
   tjeme se povuče tako da se zatvori tačno. Radi se SAMO na izričit zahtjev i samo za
   male greške — velika razlika znači stvarnu grešku u mjeri, koju ne treba sakriti. */
function zatvoriOblik(tjemena) {
  const t = tjemena.map(p => [p[0], p[1]]);
  if (t.length < 3) return t;
  t[t.length - 1] = [t[t.length - 1][0], t[t.length - 1][1]];
  return t;
}

/* ── SMJER OBILASKA ── suprotno od kazaljke, da normale gledaju napolje ── */
function uSmjeruSuprotnoKazaljci(t) {
  let s = 0;
  for (let i = 0; i < t.length; i++) {
    const a = t[i], b = t[(i + 1) % t.length];
    s += (b[0] - a[0]) * (b[1] + a[1]);
  }
  return s > 0 ? t.slice().reverse() : t.slice();
}

/* ── PROŠIRENJE OBLIKA ZA REZ ──
   Svaka stranica se pomjeri napolje za 'r', pa se susjedne pomjerene prave presijeku.
   Za male vrijednosti (rez od par milimetara na komadu od metar) ovo je tačno.
   Time se debljina reza uzima u obzir i kod nepravilnih oblika, ne samo pravougaonih. */
function prosiriPoligon(tjemena, r) {
  if (!r) return tjemena;
  const t = uSmjeruSuprotnoKazaljci(tjemena);
  const n = t.length;
  const prave = t.map((p, i) => {
    const q = t[(i + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const L = Math.hypot(dx, dy) || 1;
    const nx = dy / L, ny = -dx / L;            // normala prema spolja
    return { t: [p[0] + nx * r, p[1] + ny * r], s: [dx / L, dy / L] };
  });
  const out = [];
  for (let i = 0; i < n; i++) {
    const A = prave[(i - 1 + n) % n], B = prave[i];
    const nazivnik = A.s[0] * B.s[1] - A.s[1] * B.s[0];
    if (Math.abs(nazivnik) < 1e-9) { out.push(B.t); continue; }   // paralelne
    const k = ((B.t[0] - A.t[0]) * B.s[1] - (B.t[1] - A.t[1]) * B.s[0]) / nazivnik;
    out.push([A.t[0] + A.s[0] * k, A.t[1] + A.s[1] * k]);
  }
  return out;
}

/* ── DA LI KOMAD (bilo kog oblika) STAJE U RESTL ──
   Uslov: sva tjemena komada su unutar restla ili na ivici, i nijedna stranica komada
   ne presijeca stranicu restla. Proba se u četiri okreta i po mreži položaja.
   Kao i kod pravougaonika, greška ide na SIGURNU stranu — može propustiti tijesno
   rješenje, ali nikad neće reći da staje nešto što ne staje. */
function okreni(t, stepeni) {
  const a = stepeni * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return t.map(p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]);
}

function komadUnutra(restl, komad) {
  for (const p of komad) if (!tackaUnutraIliNa(restl, p[0], p[1])) return false;
  for (let i = 0; i < komad.length; i++) {
    const a = komad[i], b = komad[(i + 1) % komad.length];
    for (let j = 0; j < restl.length; j++) {
      if (duziSijeku(a, b, restl[j], restl[(j + 1) % restl.length])) return false;
    }
    // središte stranice mora biti unutra — hvata slučaj uskog vrata
    if (!tackaUnutraIliNa(restl, (a[0]+b[0])/2, (a[1]+b[1])/2)) return false;
  }
  return true;
}

/* ── UGLOVI KOJE VRIJEDI PROBATI ──
   Nema ograničenja na 90° — mašina siječe pod bilo kojim uglom. Ali probati svaki
   stepen redom bilo bi sporo i besmisleno, pa se biraju uglovi koji NEŠTO ZNAČE:
   oni pri kojima neka stranica komada legne paralelno sa nekom stranicom restla.
   Optimalno rješenje kod pakovanja poligona skoro uvijek ima tu osobinu. Uz njih
   idu i četiri prava okreta, plus gruba mreža kao mreža za hvatanje ostatka. */
function kandidatUglovi(restl, komad, gustina) {
  const pravac = t => t.map((p, i) => {
    const q = t[(i + 1) % t.length];
    let u = Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI;
    return ((u % 180) + 180) % 180;              // pravac, ne smjer
  });
  const ur = pravac(restl), uk = pravac(komad);
  const skup = new Set([0, 90, 180, 270]);
  for (const a of ur) for (const b of uk) {
    const razlika = ((a - b) % 360 + 360) % 360;
    skup.add(Math.round(razlika * 10) / 10);
    skup.add(Math.round(((razlika + 180) % 360) * 10) / 10);
  }
  // Dijagonale: komad koji ne staje ni po jednoj stranici često staje po dijagonali
  // restla. Zato se dodaju i uglovi koji poravnavaju najdužu osu komada sa svakom
  // dijagonalom restla — bez toga bi dugačak komad ispao neuklopiv iako staje.
  const najduzaOsa = t => {
    let naj = 0, ugao = 0;
    for (let i = 0; i < t.length; i++)
      for (let j = i + 1; j < t.length; j++) {
        const d = Math.hypot(t[j][0] - t[i][0], t[j][1] - t[i][1]);
        if (d > naj) { naj = d; ugao = Math.atan2(t[j][1] - t[i][1], t[j][0] - t[i][0]) * 180 / Math.PI; }
      }
    return ((ugao % 180) + 180) % 180;
  };
  const osaK = najduzaOsa(komad);
  for (let i = 0; i < restl.length; i++)
    for (let j = i + 1; j < restl.length; j++) {
      const u = Math.atan2(restl[j][1] - restl[i][1], restl[j][0] - restl[i][0]) * 180 / Math.PI;
      const d = ((u % 180) + 180) % 180 - osaK;
      skup.add(Math.round((((d % 360) + 360) % 360) * 10) / 10);
      skup.add(Math.round(((((d + 180) % 360) + 360) % 360) * 10) / 10);
    }

  const korak = gustina || 10;                    // gruba mreža kao dopuna
  for (let u = 0; u < 360; u += korak) skup.add(u);
  return [...skup].sort((a, b) => {
    const bliskost = x => Math.min(x % 90, 90 - (x % 90));   // pravi uglovi prvi
    return bliskost(a) - bliskost(b);
  });
}

/* ── DA LI KOMAD STAJE U RESTL, POD BILO KOJIM UGLOM ──
   Vraća položaj i ugao pod kojim komad ulazi. Uglovi se probaju redom od onih
   najbližih pravom, jer je takvo postavljanje u radionici najpraktičnije —
   prvo pronađeno rješenje je time i najpogodnije, ne samo bilo koje. */
function poligonStaje(restlT, komadT, rezerva, opcije) {
  const restl = restlT;
  const osnovni = prosiriPoligon(komadT, Number(rezerva) || 0);
  const or = okvir(restl);
  const o = opcije || {};
  const uglovi = o.samoPraviUglovi ? [0, 90, 180, 270]
                                   : kandidatUglovi(restl, osnovni, o.korakUgla);
  const podjela = o.podjela || 20;

  for (const stepeni of uglovi) {
    const k = okreni(osnovni, stepeni);
    const ok2 = okvir(k);

    // Površina je nepromjenljiva pri okretanju, pa je ovo jedini brzi odbačaj koji
    // vrijedi. Poređenje okvira NE valja kod ukošenog komada: njegov osni okvir je
    // mnogo veći od njega samog, pa bi ispao odbačen iako po dijagonali staje.
    if (povrsinaPoligona(k) > povrsinaPoligona(restl) + 0.001) continue;

    const bazni = k.map(p => [p[0] - ok2.minX, p[1] - ok2.minY]);

    // Komad se pomjera po CIJELOM restlu, umanjenom za sopstveni okvir samo ako
    // taj okvir uopšte staje. Kod ukošenog komada raspon ide preko granica okvira.
    const rasponX = or.maxX - ok2.sirina, rasponY = or.maxY - ok2.visina;
    const odX = Math.min(or.minX, rasponX), doX = Math.max(or.minX, rasponX);
    const odY = Math.min(or.minY, rasponY), doY = Math.max(or.minY, rasponY);
    const korakX = Math.max(1, (doX - odX) / podjela);
    const korakY = Math.max(1, (doY - odY) / podjela);

    const xs = new Set([odX, doX]), ys = new Set([odY, doY]);
    for (let x = odX; x <= doX; x += korakX) xs.add(x);
    for (let y = odY; y <= doY; y += korakY) ys.add(y);
    for (const [px, py] of restl) {
      if (px >= odX && px <= doX) xs.add(px);
      if (py >= odY && py <= doY) ys.add(py);
    }

    // Mreža pogađa uobičajene slučajeve, ali kod ukošenog komada rješenje je često
    // uska pukotina koju mreža preskoči. Zato se prvo probaju CILJANI položaji: svako
    // tjeme komada dovedeno tačno na svako tjeme restla. Optimalno pakovanje skoro
    // uvijek ima bar jedan takav dodir.
    const ciljani = [];
    for (const rt of restl) for (const kt of bazni) {
      ciljani.push([rt[0] - kt[0], rt[1] - kt[1]]);
    }
    for (const [x, y] of ciljani) {
      const pomjeren = bazni.map(p => [p[0] + x, p[1] + y]);
      if (komadUnutra(restl, pomjeren)) {
        return { x, y, okret: Math.round(stepeni * 10) / 10, tjemena: pomjeren };
      }
    }

    for (const x of xs) for (const y of ys) {
      const pomjeren = bazni.map(p => [p[0] + x, p[1] + y]);
      if (komadUnutra(restl, pomjeren)) {
        return { x, y, okret: Math.round(stepeni * 10) / 10, tjemena: pomjeren };
      }
    }
  }

  return null;
}

/* ── KOLIKO FALI DA KOMAD STANE ──
   Restl se u koracima "naduva" i gleda se pri kojem bi komad ušao. Rezultat je
   koliko milimetara nedostaje — ploča bi morala biti tolika veća, ili komad toliko
   manji. Vraća null ako ne staje ni uz najveće dozvoljeno odstupanje. */
function kolikoFali(restlT, komadT, rezerva, koraci) {
  const stepenice = koraci && koraci.length ? koraci : [5, 10, 20, 30, 50, 100];
  for (const mm of stepenice) {
    const veci = prosiriPoligon(restlT, mm);
    const poz = poligonStaje(veci, komadT, rezerva);
    if (poz) return { fali: mm, polozaj: poz };
  }
  return null;
}

/* ── provjera ispravnosti unesenog oblika ── */
function provjeriTjemena(t) {
  if (!Array.isArray(t) || t.length < 3) return 'Oblik mora imati najmanje 3 tjemena.';
  for (const p of t) {
    if (!Array.isArray(p) || p.length !== 2 || !isFinite(p[0]) || !isFinite(p[1]))
      return 'Svako tjeme mora imati dva broja (X i Y u mm).';
  }
  if (povrsinaPoligona(t) <= 0) return 'Oblik ima nultu površinu — provjeri tjemena.';
  // Samopresijecanje (npr. "leptir") — takav oblik ne postoji fizički
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 2; j < t.length; j++) {
      if (i === 0 && j === t.length - 1) continue;
      if (duziSijeku(t[i], t[(i+1) % t.length], t[j], t[(j+1) % t.length]))
        return 'Stranice oblika se presijecaju — provjeri redoslijed tjemena.';
    }
  }
  return null;
}

module.exports = {
  tjemenaOdMjera, tjemenaOdStrana, stvarnaDuzina, zatvoriOblik, povrsinaPoligona,
  okvir, tackaUnutra, tackaUnutraIliNa, prosiriPoligon, poligonStaje, okreni, komadUnutra,
  kolikoFali, kandidatUglovi,
  pravougaonikUnutra, komadStaje, provjeriTjemena,
};
