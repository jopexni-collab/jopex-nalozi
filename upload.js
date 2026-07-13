const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const BUCKET = process.env.R2_BUCKET || 'jopex';
const ENDPOINT = process.env.R2_ENDPOINT || 'https://7118192006a9c55d294d9b900bee958b.r2.cloudflarestorage.com';
const ACCESS_KEY = process.env.R2_ACCESS_KEY || 'ecc83e5898e97d7f325349ebb5bb38a8';
const SECRET_KEY = process.env.R2_SECRET_KEY || '20172d765b710548c1914b5d3ec0cfa8dcc886757e70f910409df923c0b691dc';
const PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://pub-ee5c1c6788b94bd6aa6c888bb8a24fb4.r2.dev';

// Jednostavan HMAC-SHA256
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function uploadToR2(key, buffer, contentType) {
  const fullUrl = `${ENDPOINT}/${BUCKET}/${key}`;
  console.log('R2 URL:', fullUrl);
  const url = new URL(fullUrl);
  const host = url.hostname;
  const path = url.pathname;
  
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').substring(0, 8);
  const datetimeStr = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').substring(0, 15) + 'Z';
  const region = 'auto';
  const service = 's3';

  const payloadHash = sha256(buffer);

  const headers = {
    'host': host,
    'x-amz-date': datetimeStr,
    'x-amz-content-sha256': payloadHash,
    'content-type': contentType,
    'content-length': buffer.length.toString(),
  };

  const sortedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaders.map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeaders = sortedHeaders.join(';');

  const canonicalRequest = [
    'PUT', path, '',
    canonicalHeaders, signedHeaders, payloadHash
  ].join('\n');

  const credScope = `${dateStr}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', datetimeStr, credScope, sha256(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStr), region), service), 'aws4_request');
  const signature = hmacHex(signingKey, stringToSign);

  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path: path,
      method: 'PUT',
      headers: { ...headers, 'Authorization': authorization },
    };
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(`${PUBLIC_URL}/${key}`);
        } else {
          reject(new Error(`R2 HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

router.post('/', async (req, res) => {
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
