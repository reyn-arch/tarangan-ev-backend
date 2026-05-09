const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../models/db');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const router = express.Router();

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Brevo email sender
async function sendEmailViaBrevo(toEmail, subject, textContent) {
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: toEmail }],
      subject: subject,
      textContent: textContent,
    }, {
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json'
      }
    });
    console.log(`Email sent to ${toEmail}: ${subject}`);
    return true;
  } catch (error) {
    console.error(`Brevo error:`, error.response?.data || error.message);
    return false;
  }
}

// Register
router.post('/register', upload.fields([{ name: 'idPhoto' }, { name: 'selfie' }]), async (req, res) => {
  const { fullname, email, password, role, phone, plate_number } = req.body;
  if (!['commuter','driver','admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const hashed = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query(
      `INSERT INTO users (fullname, email, password_hash, role, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [fullname, email, hashed, role, phone]
    );
    const userId = userRes.rows[0].id;
    if (role === 'driver') {
      const idPhotoPath = req.files?.idPhoto ? req.files.idPhoto[0].path : null;
      const selfiePath = req.files?.selfie ? req.files.selfie[0].path : null;
      await client.query(
  `INSERT INTO drivers (user_id, id_photo_path, selfie_path, is_approved) VALUES ($1,$2,$3,false)`,
  [userId, idPhotoPath, selfiePath]
);
    }
    await client.query('COMMIT');
    const token = jwt.sign({ id: userId, role }, process.env.JWT_SECRET);
    res.json({ token, user: { id: userId, fullname, email, role } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
  if (user.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.rows[0].role === 'driver') {
    const driver = await pool.query(`SELECT is_approved FROM drivers WHERE user_id = $1`, [user.rows[0].id]);
    if (driver.rows.length === 0) return res.status(401).json({ error: 'Driver profile not found' });
    if (!driver.rows[0].is_approved) return res.status(403).json({ error: 'Pending admin approval' });
  }
  const token = jwt.sign({ id: user.rows[0].id, role: user.rows[0].role }, process.env.JWT_SECRET);
  res.json({ token, user: user.rows[0] });
});

// Forgot password – OTP via Brevo
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const user = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (user.rows.length === 0) return res.json({ message: 'If that email exists, an OTP has been sent.' });
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60000);
  await pool.query(`UPDATE password_resets SET used = true WHERE email = $1 AND used = false`, [email]);
  await pool.query(`INSERT INTO password_resets (email, otp, expires_at) VALUES ($1,$2,$3)`, [email, otp, expiresAt]);
  const sent = await sendEmailViaBrevo(email, 'Password Reset OTP', `Your OTP is: ${otp}\nExpires in 10 minutes.`);
  if (sent) res.json({ message: 'OTP sent' });
  else res.status(500).json({ error: 'Failed to send OTP' });
});

// Verify OTP
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  const result = await pool.query(
    `SELECT * FROM password_resets WHERE email = $1 AND otp = $2 AND used = false AND expires_at > NOW()`,
    [email, otp]
  );
  if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired OTP' });
  res.json({ valid: true });
});

// Reset password
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  const result = await pool.query(
    `SELECT * FROM password_resets WHERE email = $1 AND otp = $2 AND used = false AND expires_at > NOW()`,
    [email, otp]
  );
  if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired OTP' });
  const hashed = await bcrypt.hash(newPassword, 10);
  await pool.query(`UPDATE users SET password_hash = $1 WHERE email = $2`, [hashed, email]);
  await pool.query(`UPDATE password_resets SET used = true WHERE id = $1`, [result.rows[0].id]);
  res.json({ message: 'Password updated' });
});

module.exports = router;