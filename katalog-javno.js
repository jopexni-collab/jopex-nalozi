// routes/katalog-javno.js
// Javni pristup katalogu — kupac otvara link BEZ prijave. Pristup ide iskljucivo preko
// nasumicnog tokena (isti obrazac kao otpremnice-javno / uplate-javno), ne preko ID-ja,
// pa se ne moze pogoditi mijenjanjem broja u adresi.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { ucitajStavke } = require('./katalog');

// GET /api/katalog-javno/:token
router.get('/:token', async (req, res) => {
  try {
    const k = await pool.query('SELECT * FROM katalozi WHERE javni_token=$1', [req.params.token]);
    if (!k.rows.length) return res.status(404).json({ error: 'Katalog nije pronađen ili je uklonjen.' });
    const kat = k.rows[0];

    // Broji se koliko je puta otvoren — posiljalac vidi da li ga je kupac uopste pogledao.
    pool.query('UPDATE katalozi SET broj_otvaranja = broj_otvaranja + 1 WHERE id=$1', [kat.id])
      .catch(() => {});

    const podaci = await ucitajStavke({
      grupe: kat.grupe || [],
      objekt_id: kat.objekt_id,
      tip_kupca_id: kat.tip_kupca_id,
      samo_dostupno: kat.samo_dostupno,
      debljine: kat.debljine || [],
      sifre: kat.sifre || [],
    });

    // Ako je poslato BEZ cijena, cijene se uklanjaju OVDJE (na serveru) — ne salju se
    // uopste, pa se ne mogu izvuci ni kroz alate pregledaca.
    let stavke = kat.sa_cijenama
      ? podaci.stavke
      : podaci.stavke.map(({ cijena, cijena_bez_pdv, pdv_iznos, ...ostalo }) => ostalo);
    // Katalog samo sa gotovim proizvodima ne salje materijale
    if (kat.sta_ulazi === 'gotovi') stavke = [];
    else if (jezik !== 'bs') stavke = stavke.map(s => ({ ...s, grupa: pr(s.grupa) }));

    /* GOTOVI PROIZVODI — sastavnice sa zamrznutim cjenovnikom.
       Cijene se NE racunaju ovdje uzivo: katalog mora pokazivati ono sto je bilo
       snimljeno, inace bi se odstampana cijena razlikovala od one na ekranu.
       Proizvod bez snimljenog cjenovnika prolazi — uz njega stoji "na upit". */
    /* Rjecnik prijevoda — baza i unos ostaju na nasem jeziku, prijevod se trazi tek
       ovdje. Sto nije prevedeno ostaje kako jeste, pa katalog nikad nije prazan. */
    const jezik = kat.jezik || 'bs';
    let prijevodi = {};
    if (jezik !== 'bs') {
      try {
        const { mapaPrijevoda } = require('./prijevodi');
        prijevodi = await mapaPrijevoda(jezik);
      } catch (e) { /* bez rjecnika ide na nasem */ }
    }
    const pr = t => (t && prijevodi[String(t).toLowerCase()]) || t;

    let gotovi = [];
    if (kat.gotovi_proizvodi && Array.isArray(kat.gotovi_ids) && kat.gotovi_ids.length) {
      const gp = await pool.query(
        `SELECT p.id, p.naziv, p.naziv_en, p.naziv_it, p.naziv_de, p.naziv_fr, p.opis, p.slika_url,
                p.cjenovnik_kada, p.moguci_oblici, gp.naziv AS grupa_naziv, gp.oblik
         FROM gotovi_proizvodi p
         LEFT JOIN grupe_proizvoda gp ON gp.id = p.grupa_proizvoda_id
         WHERE p.id = ANY($1::int[]) AND p.aktivan = true
         ORDER BY gp.redosled NULLS LAST, gp.naziv NULLS LAST, p.naziv`,
        [kat.gotovi_ids]
      );

      const cijene = kat.sa_cijenama
        ? (await pool.query(
            `SELECT gotov_id, opis_izbora, dimenzija, povrsina_m2, cijena, valuta
             FROM gotov_cjenovnik WHERE gotov_id = ANY($1::int[])
             ORDER BY dimenzija, opis_izbora`, [kat.gotovi_ids]
          )).rows
        : [];

      /* Dimenzije sa OBLIKOM — katalog uz cijenu pokazuje i kako sto izgleda
         (pravougaoni, okrugli, bacvasti...), sto kupcu govori vise od same brojke. */
      const dim = (await pool.query(
        /* Samo mjere oznacene za katalog — ostale se racunaju, ali se ne stampaju. */
        `SELECT gotov_id, oblik, mjere, moguci_oblici, sirina, visina, precnik, naziv
         FROM gotov_dimenzije
         WHERE gotov_id = ANY($1::int[]) AND COALESCE(u_katalogu, true) = true
         ORDER BY redosled, id`,
        [kat.gotovi_ids]
      )).rows;

      /* Materijali od kojih se proizvod pravi — iz komponenti sastavnice.
         Kupcu je bitno da zna da je ploca granit, a ne samo koliko kosta. */
      /* Sastojci: sta je STVARNO izabrano i koje su grupe jos dozvoljene.
         Cijena vazi za izabrani artikal; ostale grupe idu kao "dostupno i u". */
      const mat = (await pool.query(
        `SELECT st.gotov_id, st.sastojak_id,
                ro.grupa, ro.naziv AS artikal, ro.debljina_cm,
                sa.naziv AS sastojak, sa.redni_broj, sa.dozvoljene_grupe
         FROM gotov_stavke st
         JOIN roba ro ON ro.id = st.roba_id
         LEFT JOIN grupa_sastojci sa ON sa.id = st.sastojak_id
         WHERE st.gotov_id = ANY($1::int[])
         ORDER BY sa.redni_broj NULLS LAST, ro.naziv`,
        [kat.gotovi_ids]
      )).rows;

      gotovi = gp.rows.map(p => ({
        ...p,
        naziv: pr(p.naziv),
        grupa_naziv: pr(p.grupa_naziv),
        // Bez cijena se ne salju uopste — ne mogu se izvuci ni alatima pregledaca
        cijene: kat.sa_cijenama ? cijene.filter(x => x.gotov_id === p.id) : [],
        na_upit: kat.sa_cijenama && !cijene.some(x => x.gotov_id === p.id),
        dimenzije: dim.filter(x => x.gotov_id === p.id),

        /* Sastojci sa IZABRANIM artiklom — kupcu se pokazuje model postolja i konkretan
           materijal, ne interni naziv grupe. */
        sastojci: (() => {
          const moji = mat.filter(x => x.gotov_id === p.id);
          const po = {};
          for (const x of moji) {
            const k = x.sastojak || 'Dio';
            (po[k] = po[k] || { naziv: k, redni: x.redni_broj || 99, artikli: [], grupe: new Set(), dozvoljene: new Set() })
              .artikli.push(x.artikal);
            po[k].grupe.add(x.grupa);
            for (const g of (x.dozvoljene_grupe || [])) po[k].dozvoljene.add(g);
          }
          return Object.values(po)
            .sort((a, b) => a.redni - b.redni)
            .map(s => ({
              naziv: pr(s.naziv),
              artikli: [...new Set(s.artikli)],
              // Grupe koje su dozvoljene, a nisu iskoristene — kupac ih moze traziti
              ostale_grupe: [...s.dozvoljene].filter(g =>
                ![...s.grupe].some(x => String(x).toLowerCase() === String(g).toLowerCase())).map(pr),
            }));
        })(),

        materijali: [...new Set(mat.filter(x => x.gotov_id === p.id).map(x => pr(x.grupa)))],
      }));
    }

    res.json({
      naslov: kat.naslov,
      sta_ulazi: kat.sta_ulazi || 'materijali',
      /* Jezik i valuta prikaza — prevod naziva i preracun po fiksnom kursu rade se
         u samom dokumentu, da se ne mijenja ono sto je snimljeno. */
      jezik: kat.jezik || 'bs',
      valuta: kat.valuta || 'KM',
      gotovi,
      kupac_naziv: kat.kupac_naziv,
      tip_naziv: kat.tip_naziv,
      prikaz: kat.prikaz,
      sa_cijenama: kat.sa_cijenama,
      sa_pdv: podaci.sa_pdv,
      pdv_stopa: podaci.pdv_stopa,
      kreirao_ime: kat.kreirao_ime,
      kreirano: kat.kreirano,
      stavke,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
