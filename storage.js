// storage.js — apstrakcija skladišta fajlova. Tip servera se bira preko env promjenljive
// FILE_STORAGE_TYPE ('r2' ili 'ftp', podrazumjevano 'r2' — postojeće ponašanje ostaje
// nepromijenjeno ako se env ne doda). Svaki konkretan provajder implementira ISTU
// funkciju: uploadFile(key, buffer, contentType) -> Promise<javniUrl>.
//
// Da bi se dodao TREĆI tip servera u budućnosti (npr. Google Drive), dovoljno je dodati
// novu granu u uploadFile() ispod, sa istim potpisom.

const crypto = require('crypto');
const https = require('https');
const http = require('http');

const STORAGE_TYPE = (process.env.FILE_STORAGE_TYPE || 'r2').toLowerCase();

/* ═══════════════════════════ R2 (Cloudflare, S3-kompatibilan) ═══════════════════════ */
const R2_BUCKET = process.env.R2_BUCKET || 'jopex';
const R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://7118192006a9c55d294d9b900bee958b.r2.cloudflarestorage.com';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY || 'ecc83e5898e97d7f325349ebb5bb38a8';
const R2_SECRET_KEY = process.env.R2_SECRET_KEY || '20172d765b710548c1914b5d3ec0cfa8dcc886757e70f910409df923c0b691dc';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://pub-ee5c1c6788b94bd6aa6c888bb8a24fb4.r2.dev';

function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function hmacHex(key, data) { return crypto.createHmac('sha256', key).update(data).digest('hex'); }
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

async function uploadToR2(key, buffer, contentType) {
  const fullUrl = `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
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
  const canonicalRequest = ['PUT', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credScope = `${dateStr}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', datetimeStr, credScope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${R2_SECRET_KEY}`, dateStr), region), service), 'aws4_request');
  const signature = hmacHex(signingKey, stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const options = { hostname: host, path, method: 'PUT', headers: { ...headers, 'Authorization': authorization } };
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(`${R2_PUBLIC_URL}/${key}`);
        else reject(new Error(`R2 HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

/* ═══════════════════════════ FTP (generički, bilo koji provajder) ═══════════════════ */
// Potreban paket: npm install basic-ftp (dodano u package.json).
// Env: FTP_HOST, FTP_PORT (podrazumjevano 21), FTP_USER, FTP_PASSWORD,
//      FTP_BASE_PATH (udaljeni folder u koji se upload-uje, npr. /public_html/uploads),
//      FTP_PUBLIC_URL (javni HTTP URL koji odgovara FTP_BASE_PATH — server mora imati
//      web server koji servira te iste fajlove preko HTTP-a da bi link radio),
//      FTP_SECURE ('true' za FTPS, inače obični FTP).
async function uploadToFtp(key, buffer, contentType) {
  const ftp = require('basic-ftp');
  const { Readable } = require('stream');

  const host = process.env.FTP_HOST;
  const port = parseInt(process.env.FTP_PORT) || 21;
  const user = process.env.FTP_USER;
  const password = process.env.FTP_PASSWORD;
  const basePath = (process.env.FTP_BASE_PATH || '/').replace(/\/+$/, '');
  const publicUrl = (process.env.FTP_PUBLIC_URL || '').replace(/\/+$/, '');
  const secure = (process.env.FTP_SECURE || '').toLowerCase() === 'true';

  if (!host || !user || !password || !publicUrl)
    throw new Error('FTP nije podešen — nedostaje FTP_HOST/FTP_USER/FTP_PASSWORD/FTP_PUBLIC_URL u .env.');

  const client = new ftp.Client();
  try {
    await client.access({ host, port, user, password, secure });
    const punaPutanja = `${basePath}/${key}`;
    const folder = punaPutanja.substring(0, punaPutanja.lastIndexOf('/'));
    await client.ensureDir(folder);
    // ensureDir mijenja "trenutni folder" na klijentu — vraćamo se na root prije uploadTo
    // koji očekuje punu udaljenu putanju.
    await client.cd('/');
    await client.uploadFrom(Readable.from(buffer), punaPutanja);
    return `${publicUrl}/${key}`;
  } finally {
    client.close();
  }
}

/* ═══════════════════════════ Javni, jedinstveni interfejs ═══════════════════════════ */
// uploadFile(key, buffer, contentType) -> Promise<string javniUrl>
// "key" je relativna putanja unutar skladišta (npr. "ponude/json/naziv.json") — ISTA za
// oba tipa servera, provajder-specifična logika ostaje sakrivena unutar ovog fajla.
async function uploadFile(key, buffer, contentType) {
  if (STORAGE_TYPE === 'ftp') return uploadToFtp(key, buffer, contentType);
  if (STORAGE_TYPE === 'r2') return uploadToR2(key, buffer, contentType);
  throw new Error(`Nepoznat FILE_STORAGE_TYPE: "${STORAGE_TYPE}" (očekivano 'r2' ili 'ftp').`);
}

module.exports = { uploadFile, STORAGE_TYPE };
