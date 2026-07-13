const express = require('express');
const router = express.Router();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY || '',
    secretAccessKey: process.env.R2_SECRET_KEY || '',
  },
});

const BUCKET = process.env.R2_BUCKET || 'jopex';
const PUBLIC_URL = process.env.R2_PUBLIC_URL || process.env.R2_ENDPOINT + '/' + BUCKET;

async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return `${PUBLIC_URL}/${key}`;
}

// POST /api/upload
// Body: { naziv, dxf_b64, radni_nalog_b64, ponuda_b64 }
router.post('/', async (req, res) => {
  console.log('R2 debug:', {
    endpoint: process.env.R2_ENDPOINT,
    bucket: process.env.R2_BUCKET,
    accessKey: process.env.R2_ACCESS_KEY ? process.env.R2_ACCESS_KEY.substring(0,8)+'...' : 'MISSING',
    secretKey: process.env.R2_SECRET_KEY ? 'SET' : 'MISSING',
  });
  try {
    const { naziv, dxf_b64, radni_nalog_b64, ponuda_b64 } = req.body;
    if (!naziv) return res.status(400).json({ error: 'naziv je obavezan.' });

    const rezultat = {};
    const ts = new Date().toISOString().split('T')[0];

    if (dxf_b64) {
      const buf = Buffer.from(dxf_b64, 'base64');
      rezultat.dxf_link = await uploadToR2(`nalozi/${ts}_${naziv}.dxf`, buf, 'application/octet-stream');
    }

    if (radni_nalog_b64) {
      const buf = Buffer.from(radni_nalog_b64, 'base64');
      rezultat.radni_nalog_link = await uploadToR2(`nalozi/${ts}_${naziv}_nalog.pdf`, buf, 'application/pdf');
    }

    if (ponuda_b64) {
      const buf = Buffer.from(ponuda_b64, 'base64');
      rezultat.ponuda_link = await uploadToR2(`ponude/pdf/${ts}_${naziv}_ponuda.pdf`, buf, 'application/pdf');
    }

    res.json({ ok: true, ...rezultat });
  } catch (err) {
    console.error('R2 upload greška:', err.message);
    res.status(500).json({ error: 'Greška pri uploadu: ' + err.message });
  }
});

// POST /api/upload/ponuda-json
// Čuvanje JSON ponude na R2
router.post('/ponuda-json', async (req, res) => {
  try {
    const { naziv, json_b64 } = req.body;
    if (!naziv || !json_b64) return res.status(400).json({ error: 'naziv i json_b64 su obavezni.' });
    const buf = Buffer.from(json_b64, 'base64');
    const key = `ponude/json/${naziv}.json`;
    const link = await uploadToR2(key, buf, 'application/json');
    res.json({ ok: true, link, key });
  } catch (err) {
    res.status(500).json({ error: 'Greška: ' + err.message });
  }
});

module.exports = router;
