const express = require('express');
const router = express.Router();
const { uploadFile } = require('./storage');

router.post('/', async (req, res) => {
  try {
    const { naziv, dxf_b64, radni_nalog_b64, radni_nalog_html_b64, ponuda_b64 } = req.body;
    if (!naziv) return res.status(400).json({ error: 'naziv je obavezan.' });

    const rezultat = {};
    const ts = new Date().toISOString().split('T')[0];

    if (dxf_b64) {
      const buf = Buffer.from(dxf_b64, 'base64');
      rezultat.dxf_link = await uploadFile(`nalozi/${ts}_${naziv}.dxf`, buf, 'application/octet-stream');
    }

    if (radni_nalog_html_b64) {
      const buf = Buffer.from(radni_nalog_html_b64, 'base64');
      rezultat.radni_nalog_link = await uploadFile(`nalozi/${ts}_${naziv}_nalog.html`, buf, 'text/html;charset=utf-8');
    } else if (radni_nalog_b64) {
      const buf = Buffer.from(radni_nalog_b64, 'base64');
      rezultat.radni_nalog_link = await uploadFile(`nalozi/${ts}_${naziv}_nalog.pdf`, buf, 'application/pdf');
    }

    if (ponuda_b64) {
      const buf = Buffer.from(ponuda_b64, 'base64');
      rezultat.ponuda_link = await uploadFile(`ponude/pdf/${ts}_${naziv}_ponuda.pdf`, buf, 'application/pdf');
    }

    res.json({ ok: true, ...rezultat });
  } catch (err) {
    console.error('Upload greška:', err.message);
    res.status(500).json({ error: 'Greška pri uploadu: ' + err.message });
  }
});

router.post('/ponuda-json', async (req, res) => {
  try {
    const { naziv, json_b64 } = req.body;
    if (!naziv || !json_b64) return res.status(400).json({ error: 'naziv i json_b64 su obavezni.' });
    const buf = Buffer.from(json_b64, 'base64');
    const key = `ponude/json/${naziv}.json`;
    const link = await uploadFile(key, buf, 'application/json');
    res.json({ ok: true, link, key });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

// POST /api/upload/slika - brz upload jedne slike (npr. skica ili ponuda uslikana
// telefonom direktno u brzoj formi index.html) — vraća link, bez potrebe za R.Br. ili
// nazivom naloga (koji u tom trenutku možda još nije ni sačuvan).
router.post('/slika', async (req, res) => {
  try {
    const { slika_b64, tip } = req.body;
    if (!slika_b64) return res.status(400).json({ error: 'slika_b64 je obavezno.' });
    const buf = Buffer.from(slika_b64, 'base64');
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const folder = tip === 'ponuda' ? 'ponude' : 'skice';
    const key = `${folder}/${ts}-${rand}.jpg`;
    const link = await uploadFile(key, buf, 'image/jpeg');
    res.json({ ok: true, link });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri uploadu slike: ' + err.message });
  }
});

module.exports = router;
