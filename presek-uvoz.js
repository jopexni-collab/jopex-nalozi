// presek-uvoz.js — čitanje i priprema XLSX preseka lagera (usaglašavanje sa stvarnim
// stanjem, ne obican uvoz koji SAMO dodaje). Isti obrazac kao restlovi-uvoz.js:
//
// Ovdje NEMA upisa u bazu ni pristupa mreži — samo pretvaranje redova iz tabele u oblik
// koji modul razumije, plus provjere. Poređenje sa TRENUTNIM stanjem (iz baze) se radi u
// roba.js (koji ovaj modul poziva), ne ovdje — da ovaj dio ostane čist i testabilan sam.
//
// KLJUČ za svaki artikal je ŠIFRA (4 cifre) — bez šifre, red se ne može upariti, ostaje
// u statusu 'greska' dok se ručno ne dopuni (nijedan red se ne preskače tiho).

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

/* ── brojevi — pokriva i "1.234,56" (evropski format) i "1234.56" ── */
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

/* ── traženje kolone bez obzira na sitne razlike u nazivu (isti obrazac kao restlovi) ── */
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
  sifra:   ['sifra', 'šifra', 'sifra robe', 'code'],
  naziv:   ['naziv', 'naziv robe', 'artikal'],
  stanje:  ['stanje', 'kolicina', 'količina', 'stanje/m2/m3/kom'],
  cijena:  ['cijena', 'cena', 'unit price', 'cijena/jm'],
  grupa:   ['grupa', 'code-group', 'kategorija'],
  jm:      ['jm', 'jed mjera', 'jedinica mjere', 'unit'],
};
// Redoslijed kolona ako zaglavlje nije prepoznato po nazivu (uobičajen raspored u
// preseku): A šifra | B naziv | C stanje | D cijena
const PO_MJESTU = ['sifra', 'naziv', 'stanje', 'cijena'];

function mapaKolona(zaglavlja) {
  const m = {};
  for (const [kljuc, kandidati] of Object.entries(KOLONE)) m[kljuc] = nadjiKolonu(zaglavlja, kandidati);
  PO_MJESTU.forEach((kljuc, i) => {
    if (!m[kljuc] && zaglavlja[i] !== undefined) m[kljuc] = zaglavlja[i];
  });
  return m;
}

/* ── pretvaranje jednog reda ── */
function pripremiRed(red, m, indeks) {
  const uzmi = k => (m[k] ? red[m[k]] : '');
  const sifra = tekst(uzmi('sifra'));
  const naziv = tekst(uzmi('naziv'));
  const stanjeNovo = broj(uzmi('stanje'));
  const cijenaNova = broj(uzmi('cijena'));
  const grupa = tekst(uzmi('grupa'));
  const jm = tekst(uzmi('jm'));

  const stavka = {
    red: indeks + 2, // broj reda u Excelu, računajući zaglavlje
    sifra, naziv, stanje_novo: stanjeNovo, cijena_nova: cijenaNova, grupa, jm,
    greske: [],
  };

  const imaIkakavSadrzaj = sifra || naziv || stanjeNovo;
  if (!imaIkakavSadrzaj) { stavka.status = 'prazan'; return stavka; }

  // Šifra je GLAVNI KLJUČ (4 cifre) — bez nje se red ne može upariti sa artiklom.
  if (!sifra) {
    stavka.greske.push('nema šifru — upiši je ili preskoči red');
    stavka.status = 'greska';
    return stavka;
  }
  if (!/^\d{1,6}$/.test(sifra)) {
    stavka.greske.push(`šifra "${sifra}" nije prepoznata kao broj — provjeri da nije greškom tekst/formula`);
    stavka.status = 'greska';
    return stavka;
  }
  if (!naziv) stavka.greske.push('nema naziv (upozorenje, ne blokira)');

  stavka.status = 'na-provjeri'; // konačan status (isto/povecano/smanjeno/nova-sifra) se
                                  // određuje TEK kad se uporedi sa bazom, u roba.js
  return stavka;
}

/* ── cijeli list ── */
function pripremi(redovi) {
  if (!redovi.length) return { greska: 'List je prazan.', stavke: [], mapa: {} };
  const zaglavlja = Object.keys(redovi[0]);
  const m = mapaKolona(zaglavlja);

  const obavezne = ['sifra', 'stanje'];
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

module.exports = { citajList, listaListova, pripremi, pripremiRed, mapaKolona, broj, tekst };
