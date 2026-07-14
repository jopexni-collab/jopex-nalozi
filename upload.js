const express = require('express');
const router = express.Router();
const { google } = require('googleapis');

const FOLDER_NALOZI = '1OHH2hp43GC1BC2oAPK3QeKMXh57Ft-Dv';
const FOLDER_PONUDE = '1bT1t18x2a7-Xbl45JwGjElig4a0bGmV9';

function getDriveClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
}

async function uploadToDrive(drive, name, mimeType, base64Data, folderId) {
  const buffer = Buffer.from(base64Data, 'base64');
  const { Readable } = require('stream');
  const stream = Readable.from(buffer);
  const r = await drive.files.create({
    requestBody: {
      name,
      parents: [folderId],
      mimeType,
    },
    media: { mimeType, body: stream },
    fields: 'id,webViewLink',
  });
  // Postavi fajl kao vidljiv svima sa linkom
  await drive.permissions.create({
    fileId: r.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return r.data.webViewLink;
}

// POST /api/upload
// Body: { naziv, dxf_b64, radni_nalog_b64, ponuda_b64 }
router.post('/', async (req, res) => {
  try {
    const { naziv, dxf_b64, radni_nalog_b64, ponuda_b64 } = req.body;
    if (!naziv) return res.status(400).json({ error: 'naziv je obavezan.' });

    const drive = getDriveClient();
    const rezultat = {};

    // DXF → Nalozi folder
    if (dxf_b64) {
      rezultat.dxf_link = await uploadToDrive(
        drive, `${naziv}.dxf`, 'application/octet-stream', dxf_b64, FOLDER_NALOZI
      );
    }

    // Radni nalog PDF → Nalozi folder
    if (radni_nalog_b64) {
      rezultat.radni_nalog_link = await uploadToDrive(
        drive, `${naziv} - Radni nalog.pdf`, 'application/pdf', radni_nalog_b64, FOLDER_NALOZI
      );
    }

    // Ponuda PDF → Ponude folder
    if (ponuda_b64) {
      rezultat.ponuda_link = await uploadToDrive(
        drive, `${naziv} - Ponuda.pdf`, 'application/pdf', ponuda_b64, FOLDER_PONUDE
      );
    }

    res.json({ ok: true, ...rezultat });
  } catch (err) {
    console.error('Upload greška:', err.message);
    res.status(500).json({ error: 'Greška pri uploadu: ' + err.message });
  }
});

module.exports = router;
