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
  tjemenaOdMjera, povrsinaPoligona, okvir, tackaUnutra, tackaUnutraIliNa,
  pravougaonikUnutra, komadStaje, provjeriTjemena,
};
