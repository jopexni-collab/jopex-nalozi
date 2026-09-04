# Zabilježeno za kasnije

## 1. Trag ko je potvrdio bankovnu uplatu

**Traženo:** kad se u blagajni klikne da je uplata iz banke „viđena", da ostane trag
ko je kliknuo i kada.

**Stanje:** taj prekidač trenutno **ne postoji** u kodu — pretražio sam `gotovina.html`,
`gotovina.js` i ostale module, nema oznake „viđeno" ni sličnog polja.

**Prije nego što se radi, treba znati:**

- Gdje se tačno klikne? (Blagajna → koji tab, ili neki drugi ekran)
- Da li se radi o *izvodu iz banke* koji se uvozi, ili o ručnom unosu uplate?
- Šta „viđeno" znači u praksi — samo pregledano, ili potvrđeno da odgovara otpremnici?

Odgovor mijenja i tabelu i mjesto gdje trag stoji.

**Kad se bude radilo**, obrazac je isti kao za `roba_naziv_log`:
tabela sa `korisnik_id`, `korisnik_ime`, `kada`, plus veza na zapis koji se potvrđuje.

---

## 2. Automatski prevod naziva (EN / IT)

Polja `naziv_en`, `naziv_it`, `naziv_gotov_en`, `naziv_gotov_it` **postoje** i unose se
ručno. Automatski prevod traži vanjski servis i ključ — nije ugrađeno.

Odluka koja se čeka: da li se prevodi unose ručno (kako je sada) ili se plaća servis.

---

## 3. Katalog sa gotovim proizvodima

Backend računa sve kombinacije (`/api/gotovi-proizvodi/:id/cijena`).
`katalozi.gotovi_proizvodi`, `prikazi_gotov_naziv`, `prikazi_gotov_sliku` i `jezik`
postoje u bazi.

**Fali:** sam prikaz u katalogu — štampani (sve kombinacije) i elektronski (kupac bira).

Prije toga vrijedi napraviti nekoliko pravih sastavnica i vidjeti da li faktori daju
očekivane cijene.

---

## 4. Ostalo iz ranijih sesija

- **Faza 3 proizvodnje** — povlačenje table sa potvrdom izdavanja i zatvaranjem
- **Uvoz restlova umanjuje lager** — sa pregledom prije potvrde i stornom po seriji
- **`ponude.html`** — nesklad `<div>` 537/538, postojao i prije izmjena
