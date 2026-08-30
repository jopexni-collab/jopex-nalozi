// nesting.js — raspoređivanje VIŠE komada u jednu ploču ili restl.
//
// Mašine sijeku i komade koji nisu dostupni giljotinskim rezom, pa se pakuje
// slobodno: svaki komad se postavlja gdje god stane, bez uslova da rez ide s kraja
// na kraj ploče.
//
// Postupak: komadi se sortiraju od najvećeg, pa se svaki spušta na prvo mjesto gdje
// staje u ploču I ne dodiruje već postavljene. Kandidatska mjesta su uglovi ploče i
// uglovi već postavljenih komada — kod pakovanja optimalno rješenje skoro uvijek ima
// bar jedan takav dodir, pa se time izbjegava pretraga po cijeloj površini.
//
// Rezultat je uvijek PROVJEREN: nijedan komad se ne preklapa i svaki je unutar ploče.
// Bolje je vratiti raspored sa dva neuklopljena komada nego raspored koji ne postoji.

const geo = require('./geometrija');

/* ── preklapanje dva poligona ──
   Komadi koji samo DODIRUJU ivice nisu preklopljeni — naprotiv, to je poželjno jer
   znači zbijeno pakovanje. Zato se ne gleda dodir nego stvarno zajedničko područje:
   svaki poligon se malo skupi prema unutra, pa se provjerava presjek. Skupljanje od
   pola milimetra ukloni dodir a zadrži svako pravo preklapanje. */
function skupi(t, za) {
  const c = centar(t);
  return t.map(p => {
    const dx = p[0] - c[0], dy = p[1] - c[1];
    const d = Math.hypot(dx, dy) || 1;
    return [p[0] - (dx / d) * za, p[1] - (dy / d) * za];
  });
}

function centar(t) {
  return [t.reduce((z, p) => z + p[0], 0) / t.length,
          t.reduce((z, p) => z + p[1], 0) / t.length];
}

function preklapaju(a0, b0) {
  const a = skupi(a0, 0.5), b = skupi(b0, 0.5);
  // Brzi odbačaj po okvirima — većina parova se ovdje riješi
  const oa = geo.okvir(a), ob = geo.okvir(b);
  if (oa.maxX <= ob.minX || ob.maxX <= oa.minX ||
      oa.maxY <= ob.minY || ob.maxY <= oa.minY) return false;

  for (const p of a) if (geo.tackaUnutra(b, p[0], p[1])) return true;
  for (const p of b) if (geo.tackaUnutra(a, p[0], p[1])) return true;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (duziSijekuStrogo(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/* ── komad kao poligon, u zadatom okretu ── */
function komadPoligon(k, okret) {
  const t = (Array.isArray(k.poligon) && k.poligon.length >= 3)
    ? k.poligon
    : [[0,0],[k.sirina,0],[k.sirina,k.visina],[0,k.visina]];
  return okret ? geo.okreni(t, okret) : t.map(p => [p[0], p[1]]);
}

function pomjeri(t, dx, dy) { return t.map(p => [p[0] + dx, p[1] + dy]); }

/* ── postavljanje jednog komada u preostali prostor ── */
function nadjiMjesto(ploca, postavljeni, komad, rez, uglovi) {
  const okviri = geo.okvir(ploca);
  const kandidatiX = new Set([okviri.minX]);
  const kandidatiY = new Set([okviri.minY]);
  for (const p of ploca) { kandidatiX.add(p[0]); kandidatiY.add(p[1]); }
  // Uglovi već postavljenih — novi komad se prislanja uz stari. Dodaju se i sami
  // uglovi i njihovi okviri: kod ukošenog komada tjemena nisu na ivici okvira, pa
  // bez okvira ostaje praznina koju nijedan sljedeći komad ne bi mogao pogoditi.
  for (const post of postavljeni) {
    for (const p of post.tjemena) { kandidatiX.add(p[0]); kandidatiY.add(p[1]); }
    const o = geo.okvir(post.tjemena);
    kandidatiX.add(o.minX); kandidatiX.add(o.maxX);
    kandidatiY.add(o.minY); kandidatiY.add(o.maxY);
  }

  let najbolji = null;
  for (const okret of uglovi) {
    const osnovni = geo.prosiriPoligon(komadPoligon(komad, okret), Number(rez) || 0);
    const ok2 = geo.okvir(osnovni);
    if (ok2.sirina > okviri.sirina + 0.01 || ok2.visina > okviri.visina + 0.01) continue;
    const bazni = osnovni.map(p => [p[0] - ok2.minX, p[1] - ok2.minY]);

    for (const x of [...kandidatiX].sort((a, b) => a - b)) {
      for (const y of [...kandidatiY].sort((a, b) => a - b)) {
        const t = pomjeri(bazni, x, y);
        if (!geo.komadUnutra(ploca, t)) continue;
        if (postavljeni.some(p => preklapaju(t, p.tjemena))) continue;
        // Bottom-left: najniže pa najljevije — daje zbijeno pakovanje
        const cijena = y * 100000 + x;
        if (!najbolji || cijena < najbolji.cijena) {
          najbolji = { cijena, x, y, okret, tjemena: t };
        }
      }
    }
    // Kosi okreti se probaju SAMO ako komad nije stao ni pod jednim pravim uglom —
    // ukošen komad je u radionici nezgodniji, pa nema smisla ako pravi ugao radi.
    if (najbolji && okret % 90 === 0) break;
  }
  return najbolji;
}

/* ── GLAVNA FUNKCIJA ──
   komadi: [{ id, naziv, sirina, visina, kolicina, poligon?, bez_okretanja? }]
   ploca:  lista tjemena u mm
   opcije: { rez, dozvoli_kosо }                                                */
function rasporedi(ploca, komadi, opcije) {
  const o = opcije || {};
  const rez = Number(o.rez) || 0;

  // Svaki komad iz količine postaje zaseban primjerak — pakuju se pojedinačno
  const spisak = [];
  for (const k of komadi) {
    const n = Math.max(1, Math.round(Number(k.kolicina) || 1));
    for (let i = 0; i < n; i++) {
      spisak.push({
        ...k,
        sirina: Number(k.sirina) || 0,
        visina: Number(k.visina) || 0,
        primjerak: i + 1,
        od_koliko: n,
      });
    }
  }
  // Najveći prvi — mali komadi lako popune rupe, obrnuto ne ide. Kod jednakih
  // površina prednost ima duži komad, jer je njemu teže naći mjesto.
  spisak.sort((a, b) => {
    const pa = a.sirina * a.visina, pb = b.sirina * b.visina;
    if (pb !== pa) return pb - pa;
    return Math.max(b.sirina, b.visina) - Math.max(a.sirina, a.visina);
  });

  const postavljeni = [];
  const neuklopljeni = [];

  for (const k of spisak) {
    // Komad koji mora zadržati pravac šare se ne okreće
    const uglovi = k.bez_okretanja ? [0]
      : (o.dozvoli_koso ? [0, 90, 180, 270, 45, 30, 60, 15, 75] : [0, 90, 180, 270]);
    const mjesto = nadjiMjesto(ploca, postavljeni, k, rez, uglovi);
    if (mjesto) {
      postavljeni.push({
        id: k.id, naziv: k.naziv, primjerak: k.primjerak, od_koliko: k.od_koliko,
        sirina: k.sirina, visina: k.visina,
        x: Math.round(mjesto.x * 10) / 10, y: Math.round(mjesto.y * 10) / 10,
        okret: mjesto.okret,
        tjemena: mjesto.tjemena.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
        povrsina: (k.sirina * k.visina) / 1e6,
      });
    } else {
      neuklopljeni.push({ id: k.id, naziv: k.naziv, sirina: k.sirina, visina: k.visina,
                          primjerak: k.primjerak, od_koliko: k.od_koliko });
    }
  }

  const povrsinaPloce = geo.povrsinaPoligona(ploca) / 1e6;
  const iskoristeno = postavljeni.reduce((z, p) => z + p.povrsina, 0);

  return {
    postavljeni, neuklopljeni,
    povrsina_ploce: Math.round(povrsinaPloce * 10000) / 10000,
    iskoristeno: Math.round(iskoristeno * 10000) / 10000,
    ostatak: Math.round((povrsinaPloce - iskoristeno) * 10000) / 10000,
    procenat: povrsinaPloce ? Math.round((iskoristeno / povrsinaPloce) * 1000) / 10 : 0,
    ukupno_komada: spisak.length,
    uklopljeno: postavljeni.length,
  };
}

/* ── provjera ispravnosti rasporeda ──
   Ovo se poziva NAD REZULTATOM, ne unutar algoritma. Ako bi ikad propustio grešku,
   ovdje se hvata — bolje prijaviti da raspored ne valja nego ga poslati u radionicu. */
function provjeriRaspored(ploca, rezultat) {
  const greske = [];
  const p = rezultat.postavljeni;
  for (let i = 0; i < p.length; i++) {
    if (!geo.komadUnutra(ploca, p[i].tjemena)) {
      greske.push(`${p[i].naziv || 'komad'} #${p[i].primjerak} izlazi izvan ploče`);
    }
    for (let j = i + 1; j < p.length; j++) {
      if (preklapaju(p[i].tjemena, p[j].tjemena)) {
        greske.push(`${p[i].naziv || 'komad'} #${p[i].primjerak} se preklapa sa ` +
                    `${p[j].naziv || 'komad'} #${p[j].primjerak}`);
      }
    }
  }
  return greske;
}

module.exports = { rasporedi, provjeriRaspored, preklapaju, komadPoligon };
