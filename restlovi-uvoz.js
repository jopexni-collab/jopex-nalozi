// restlovi-uvoz.js — čitanje i provjera XLSX tabele sa restlovima.
//
// Ovdje NEMA upisa u bazu ni pristupa mreži — samo pretvaranje redova iz tabele
// u oblik koji modul razumije, plus provjere. Zato se može testirati sam za sebe.
//
// Očekivane kolone lista (isti nazivi kao u Google Sheetu "Ostatak"):
//   r.br | uneo | lokacija | ostatak od/ nalog proiz. | Materijal | tip | sifra
//   duz A | visna B | duz C | visin D | kom | debljina | povrsina | napomena (opc)

const XLSX = require('xlsx');

/* ── čitanje ── */
function citajList(buffer, imeLista) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ime = imeLista && wb.SheetNames.includes(imeLista) ? imeLista : wb.SheetNames[0];
  return { ime, listovi: wb.SheetNames, redovi: XLSX.utils.sheet_to_json(wb.Sheets[ime], { defval: '' }) };
}

function listaListova(buffer) {
  return XLSX.read(buffer, { type: 'buffer' }).SheetNames;
}

/* ── brojevi ──
   Iz XLSX-a brojevi obično stignu kao pravi brojevi, ali ćelije koje su u Sheetu
   bile tekst dolaze kao string sa zarezom. Pokriva se oboje. */
function broj(sirovo) {
  if (typeof sirovo === 'number') return isFinite(sirovo) ? sirovo : 0;
  let s = String(sirovo ?? '').trim();
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s.replace(/\s/g, ''));
  return isFinite(n) ? n : 0;
}

function tekst(sirovo) {
  return String(sirovo ?? '').trim();
}

/* ── traženje kolone bez obzira na sitne razlike u nazivu ── */
function nadjiKolonu(zaglavlja, kandidati) {
  const ocisti = s => String(s).toLowerCase().replace(/[^a-zà-ž0-9]/gi, '');
  for (const k of kandidati) {
    const trazeni = ocisti(k);
    const pogodak = zaglavlja.find(z => ocisti(z) === trazeni);
    if (pogodak) return pogodak;
  }
  for (const k of kandidati) {
    const trazeni = ocisti(k);
    const pogodak = zaglavlja.find(z => ocisti(z).includes(trazeni));
    if (pogodak) return pogodak;
  }
  return null;
}

const KOLONE = {
  rbr:       ['r.br', 'rbr', 'r br'],
  uneo:      ['uneo'],
  lokacija:  ['lokacija'],
  nalog:     ['ostatak od/ nalog proiz.', 'k od/ nalog', 'nalog', 'ostatak od'],
  materijal: ['Materijal'],
  tip:       ['tip'],
  sifra:     ['sifra'],
  a:         ['duz A', 'duzA'],
  b:         ['visna B', 'visinaB', 'visna'],
  c:         ['duz C', 'duzC'],
  d:         ['visin D', 'visinD'],
  kom:       ['kom'],
  debljina:  ['debljina'],
  povrsina:  ['povrsina'],
  napomena:  ['napomena (opc)', 'napomena'],
};

function mapaKolona(zaglavlja) {
  const m = {};
  for (const [kljuc, kandidati] of Object.entries(KOLONE)) m[kljuc] = nadjiKolonu(zaglavlja, kandidati);
  return m;
}

/* ── L-OBLIK ──
   Onako kako ga operator crta i unosi u tabelu:
     A = ukupna visina (desna ivica)   C = ukupna širina (gornja ivica)
     B = širina donjeg kraka           D = visina gornjeg kraka
   Gornji krak ide punom širinom C, donji stoji uz DESNU ivicu.
   Prazan dio je dolje lijevo: (C−B) široko, (A−D) visoko.
   Površina = A*B + (C−B)*D — provjereno na svih 13 L-redova iz tabele. */
function tjemenaLOblika(A, B, C, D) {
  return [[C - B, 0], [C, 0], [C, A], [0, A], [0, A - D], [C - B, A - D]];
}

function tjemenaPravougaonika(A, B) {
  return [[0, 0], [A, 0], [A, B], [0, B]];
}

function povrsinaTjemena(t) {
  let s = 0;
  for (let i = 0; i < t.length; i++) {
    const a = t[i], b = t[(i + 1) % t.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/* ── pretvaranje jednog reda ── */
function pripremiRed(red, m, indeks) {
  const uzmi = k => (m[k] ? red[m[k]] : '');
  const A = broj(uzmi('a')), B = broj(uzmi('b'));
  const C = broj(uzmi('c')), D = broj(uzmi('d'));
  const kom = Math.max(1, Math.round(broj(uzmi('kom'))) || 1);
  const debljinaMm = broj(uzmi('debljina'));
  const povTabela = broj(uzmi('povrsina'));

  const stavka = {
    red: indeks + 2,                       // broj reda u Excelu, računajući zaglavlje
    rbr: tekst(uzmi('rbr')),
    uneo: tekst(uzmi('uneo')),
    lokacija: tekst(uzmi('lokacija')),
    nalog: tekst(uzmi('nalog')),
    materijal: tekst(uzmi('materijal')),
    tip: tekst(uzmi('tip')),
    sifra: tekst(uzmi('sifra')),
    debljina_cm: debljinaMm ? Math.round(debljinaMm) / 10 : null,
    kom,
    napomena: tekst(uzmi('napomena')),
    povrsina_tabela: povTabela,
    greske: [],
    upozorenja: [],
  };

  // Prazan red — samo redni broj i ime, bez ičega drugog
  const imaIkakvSadrzaj = stavka.materijal || stavka.sifra || A || B || stavka.napomena;
  if (!imaIkakvSadrzaj) { stavka.status = 'prazan'; return stavka; }

  // Potrošen komad: mjere su nule, a napomena kaže gdje je otišao
  if (!A && !B) {
    stavka.status = 'potrosen';
    stavka.poligon = null;
    stavka.povrsina = 0;
    if (!stavka.materijal) stavka.upozorenja.push('nema materijal');
    return stavka;
  }

  const jeL = C > 0 && D > 0;
  if (jeL) {
    if (C <= B) stavka.greske.push(`L-oblik: C (${C}) mora biti veće od B (${B}) — provjeri jesu li kolone zamijenjene`);
    if (A <= D) stavka.greske.push(`L-oblik: A (${A}) mora biti veće od D (${D})`);
  } else {
    if (!A || !B) stavka.greske.push('nedostaje mjera A ili B');
  }

  if (!stavka.greske.length) {
    stavka.poligon = jeL ? tjemenaLOblika(A, B, C, D) : tjemenaPravougaonika(A, B);
    stavka.oblik = jeL ? 'L-oblik' : 'pravougaonik';
    const okvirX = Math.max(...stavka.poligon.map(p => p[0]));
    const okvirY = Math.max(...stavka.poligon.map(p => p[1]));
    stavka.sirina = okvirX;
    stavka.visina = okvirY;
    stavka.povrsina = povrsinaTjemena(stavka.poligon) / 1e6;

    // Površina iz tabele je kontrola, ne izvor — ako se razilazi, prijavljujemo.
    const ocekivano = stavka.povrsina * kom;
    if (povTabela > 0 && Math.abs(ocekivano - povTabela) > 0.0005) {
      stavka.upozorenja.push(
        `površina se razlikuje: izračunato ${ocekivano.toFixed(4)} m², u tabeli ${povTabela.toFixed(4)} m²`);
    }
    stavka.status = 'dostupan';
  } else {
    stavka.status = 'greska';
  }

  if (!stavka.sifra) stavka.upozorenja.push('nema šifru — neće se povezati na artikal');
  if (!stavka.debljina_cm) stavka.upozorenja.push('nema debljinu');
  if (!stavka.materijal) stavka.upozorenja.push('nema materijal');
  return stavka;
}

/* ── cijeli list ── */
function pripremi(redovi) {
  if (!redovi.length) return { greska: 'List je prazan.', stavke: [], mapa: {} };
  const zaglavlja = Object.keys(redovi[0]);
  const m = mapaKolona(zaglavlja);

  const obavezne = ['a', 'b', 'materijal'];
  const fale = obavezne.filter(k => !m[k]);
  if (fale.length) {
    return {
      greska: 'U listu nedostaju kolone: ' + fale.join(', ') +
              '. Pronađene kolone: ' + zaglavlja.join(', '),
      stavke: [], mapa: m,
    };
  }

  const stavke = redovi.map((r, i) => pripremiRed(r, m, i)).filter(s => s.status !== 'prazan');
  return { greska: null, stavke, mapa: m, zaglavlja };
}

/* ── kratak pregled za probni prolaz ── */
function sazetak(stavke) {
  const s = {
    ukupno: stavke.length,
    dostupni: 0, potroseni: 0, greske: 0,
    pravougaonici: 0, l_oblici: 0,
    komada: 0, povrsina: 0,
    bez_sifre: 0, bez_debljine: 0, razlika_povrsine: 0,
  };
  for (const st of stavke) {
    if (st.status === 'greska') { s.greske++; continue; }
    if (st.status === 'potrosen') { s.potroseni++; s.komada += st.kom; continue; }
    s.dostupni++;
    s.komada += st.kom;
    s.povrsina += st.povrsina * st.kom;
    if (st.oblik === 'L-oblik') s.l_oblici++; else s.pravougaonici++;
    if (!st.sifra) s.bez_sifre++;
    if (!st.debljina_cm) s.bez_debljine++;
    if (st.upozorenja.some(u => u.startsWith('površina se razlikuje'))) s.razlika_povrsine++;
  }
  s.povrsina = Math.round(s.povrsina * 10000) / 10000;
  return s;
}

module.exports = {
  citajList, listaListova, pripremi, pripremiRed, sazetak,
  mapaKolona, tjemenaLOblika, tjemenaPravougaonika, povrsinaTjemena, broj,
};
