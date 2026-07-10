// routes/zaposleni.js
const express = require('express');
const router = express.Router();
const pool = require('./db');

router.get('/ugovaraci', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, ime_prezime FROM zaposleni
       WHERE moze_ugovarati = true AND aktivan = true ORDER BY ime_prezime`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Greška.' });
  }
});

module.exports = router;
