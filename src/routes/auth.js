const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../models/db');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const router = express.Router();

// Configure multer for file uploads (ID and selfie)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// REGISTER (with driver document upload)
router.post('/register', upload.fields([{ name: 'idPhoto' }, { name: 'selfie' }]), async (req, res) => {
  const { fullname, email, password, role, phone, plate_number } = req.body;
  
  if (!['commuter', 'driver', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  
  const hashed = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const userResult = await client.query(
      `INSERT INTO users (fullname, email, password_hash, role, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [fullname, email, hashed, role, phone]
    );
    const userId = userResult.rows[0].id;
    
    if (role === 'driver') {
      const idPhotoPath = req.files?.idPhoto ? req.files.idPhoto[0].path : null;
      const selfiePath = req.files?.selfie ? req.files.selfie[0].path : null;
      
      await client.query(
        `INSERT INTO drivers (user_id, plate_number, vehicle_type, id_photo_path, selfie_path, is_approved) 
         VALUES ($1, $2, 'Electric L2B', $3, $4, FALSE)`,
        [userId, plate_number, idPhotoPath, selfiePath]
      );
    }
    
    await client.query('COMMIT');
    
    const token = jwt.sign({ id: userId, role }, process.env.JWT_SECRET);
    res.json({ token, user: { id: userId, fullname, email, role } });
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: 'Registration failed. Email may already exist.' });
  } finally {
    client.release();
  }
});

// LOGIN (check driver approval)
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
  if (user.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  
  // If driver, check approval
  if (user.rows[0].role === 'driver') {
    const driver = await pool.query(`SELECT is_approved FROM drivers WHERE user_id = $1`, [user.rows[0].id]);
    if (driver.rows.length === 0) return res.status(401).json({ error: 'Driver profile not found' });
    if (!driver.rows[0].is_approved) {
      return res.status(403).json({ error: 'Your account is pending admin approval.' });
    }
  }
  
  const token = jwt.sign({ id: user.rows[0].id, role: user.rows[0].role }, process.env.JWT_SECRET);
  res.json({ token, user: user.rows[0] });
});

// FORGOT PASSWORD - Request OTP
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const user = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (user.rows.length === 0) {
    return res.json({ message: 'If that email exists, an OTP has been sent.' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60000);

  await pool.query(`UPDATE password_resets SET used = true WHERE email = $1 AND used = false`, [email]);
  await pool.query(`INSERT INTO password_resets (email, otp, expires_at) VALUES ($1, $2, $3)`, [email, otp, expiresAt]);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const mailOptions = {
    from: `"EV-HAIL-LABS" <${process.env.SMTP_FROM}>`,
    to: email,
    subject: 'Password Reset OTP',
    text: `Your OTP for password reset is: ${otp}\nIt expires in 10 minutes.`,
    html: `<p>Your OTP for password reset is: <strong>${otp}</strong></p><p>It expires in 10 minutes.</p>`,
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ message: 'OTP sent to your email' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// VERIFY OTP
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  const result = await pool.query(
    `SELECT * FROM password_resets WHERE email = $1 AND otp = $2 AND used = false AND expires_at > NOW()`,
    [email, otp]
  );
  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  res.json({ valid: true });
});

// RESET PASSWORD
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  const result = await pool.query(
    `SELECT * FROM password_resets WHERE email = $1 AND otp = $2 AND used = false AND expires_at > NOW()`,
    [email, otp]
  );
  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  const hashed = await bcrypt.hash(newPassword, 10);
  await pool.query(`UPDATE users SET password_hash = $1 WHERE email = $2`, [hashed, email]);
  await pool.query(`UPDATE password_resets SET used = true WHERE id = $1`, [result.rows[0].id]);
  res.json({ message: 'Password updated successfully' });
});

module.exports = router;