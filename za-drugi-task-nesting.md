# Za drugi task — povezivanje naloga (lista.html) sa modulom restlova

Pogledao sam kako `lista.html` već zove `/api/restlovi/trazi` u `pripremaProvjeri()`.
Uparivanje je dobro urađeno — koristi se postojeća ruta umjesto vlastite kopije geometrije.
Ispod je jedna **ispravka**, jedna **nova ruta** koja rješava netačan broj, i spisak
parametara koji se već primaju a ne koriste.

---

## 1. ISPRAVKA — šalje se naziv umjesto šifre

Pozicija ima `roba_id`, ali se u `/trazi` šalje samo `materijal` kao tekst.
Tekst se traži preko `ILIKE`, pa **"Tasto x66" pokupi i "Tasto x66 b"**.

U tijelu zahtjeva dodati jednu liniju:

```javascript
body: JSON.stringify({
  sirina: p.sirina, visina: p.visina,
  roba_id: p.roba_id || null,        // ← DODATI: tačno po artiklu, bez ILIKE pogađanja
  materijal: p.roba_naziv || p.materijal || null,
  debljina_cm: p.debljina_cm ?? null,
  poligon: ...,
  rez: 5,
}),
```

Kad je `roba_id` zadat, ruta traži tačno po tom artiklu i `materijal` se ignoriše.

---

## 2. GLAVNO — `pokriveno` trenutno broji restlove, ne komade

```javascript
pokriveno: Math.min(p.kolicina, kandidati.length),   // ← netačno
treba_tabla: Math.max(0, p.kolicina - kandidati.length),
```

`kandidati.length` je broj **restlova koji primaju bar jedan komad**, a ne broj komada.
Griješi u oba smjera:

- Pozicija traži 4 komada, nađen 1 veliki restl iz kojeg izlaze sva 4
  → prikaže **"pokriveno 1, treba tabla 3"**, a treba tabla 0.
- Pozicija traži 4 komada, nađena 4 mala restla iz kojih izlazi po 1
  → prikaže "pokriveno 4", što je slučajno tačno — ali ne uvijek.

### Rješenje: nova ruta `POST /api/restlovi/nesting/za-nalog`

Šalje se **cijela lista pozicija odjednom**, jednim pozivom umjesto petlje:

```javascript
const r = await fetch(`${API}/api/restlovi/nesting/za-nalog`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pozicije: pozStavke.map(p => ({
      id: p.id,
      naziv: p.naziv,
      sirina: p.sirina,
      visina: p.visina,
      kolicina: p.kolicina,
      roba_id: p.roba_id || null,
      materijal: p.roba_naziv || p.materijal || null,
      debljina_cm: p.debljina_cm ?? null,
      bez_okretanja: false,      // true ako pozicija mora zadržati pravac šare
    })),
    rez: 5,
    objekt_id: null,             // ako se reže u određenom PJ
  }),
});
const d = await r.json();
```

**Odgovor:**

```javascript
{
  pozicije: [{
    id, naziv, sirina, visina, kolicina,
    iz_restlova: 5,        // koliko komada STVARNO izlazi iz restlova
    treba_tabla: 1,        // koliko ostaje za cijelu tablu
    restlovi: [{
      restl_id, oznaka, objekt_naziv, dim_a, dim_b,
      komada: 4,           // koliko komada iz BAŠ TOG restla
      procenat: 82.5,      // iskorišćenost tog restla
      ostatak_m2: 0.42,
      postavljeni: [{ x, y, okret, tjemena, ... }]   // za crtež rasporeda
    }]
  }],
  sazetak: { ukupno_komada, iz_restlova, treba_tabla, restlova_u_planu }
}
```

**Isti restl se ne obećava dvaput** — kad ga jedna pozicija uzme, sljedeće ga
više ne dobijaju. Zato ide jedan poziv za cijeli nalog, a ne poziv po poziciji.

Ono što je ranije bilo `pokriveno` i `treba_tabla` sad se čita direktno iz odgovora,
bez računanja na strani liste.

---

## 3. Druga nova ruta: `POST /api/restlovi/nesting`

Raspored **jedne ploče**, kad korisnik izabere konkretan restl:

```javascript
body: JSON.stringify({
  restl_id: 123,                       // ili: poligon: [...], ili: sirina + visina
  komadi: [
    { sirina: 900, visina: 550, kolicina: 4, naziv: 'radna ploča' },
    { sirina: 600, visina: 400, kolicina: 2, naziv: 'bok', bez_okretanja: true },
  ],
  rez: 5,
  dozvoli_koso: false,                 // true = probaj i kose uglove ako drugačije ne stane
})
```

Vraća `postavljeni[]` sa tjemenima svakog komada — dovoljno za crtež rasporeda —
plus `procenat`, `ostatak`, `neuklopljeni[]` i vrijednost u KM.

**Raspored se provjerava prije slanja**: ako bi ijedan komad izlazio iz ploče ili se
preklapao s drugim, ruta vraća grešku umjesto neispravnog rasporeda.

---

## 4. Parametri koje `/trazi` već prima a ne koriste se

| Parametar | Šta radi |
|---|---|
| `roba_id` | tačna veza na artikal (vidi tačku 1) |
| `grupa` | filtriranje po grupi iz lager liste |
| `master_grupa` | filtriranje po master grupi |
| `objekt_id` | traži samo u jednom PJ |
| `odstupanje` | koliko mm tolerancije za "najbliže" kad ništa ne staje (podrazumijevano 100) |

`odstupanje: 20` ubrzava pretragu kad je svejedno da li nešto fali 50 mm.

---

## 5. Novi fajlovi na koje ove rute računaju

- `nesting.js` — algoritam raspoređivanja (novi fajl)
- `geometrija.js` — već postoji

Nema novih biblioteka.

---

## 6. Ograničenja koja treba znati

- **Rez nije giljotinski.** Raspored pretpostavlja da mašina može izvaditi komad
  koji nije dostupan rezom s kraja na kraj ploče. Potvrđeno da tako jeste.
- **Komad se okreće za 90°** po pravilu; kosi uglovi samo uz `dozvoli_koso: true`.
- **`bez_okretanja: true`** za pozicije koje moraju zadržati pravac šare — takav
  komad se uopšte ne rotira.
- Broj komada koji stane je **donja granica**, ne teorijski maksimum. Algoritam
  radije prijavi komad kao neuklopljen nego da vrati raspored koji ne postoji.
