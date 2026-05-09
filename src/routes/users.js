const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../models/db');
const { verifyToken } = require('../middleware/auth');
const router = express.Router();

// GET current user profile (includes avatar_url)
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const user = await pool.query(
      `SELECT id, fullname, email, phone, role, created_at, avatar_url FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(user.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// UPDATE user profile (fullname, phone)
router.put('/profile', verifyToken, async (req, res) => {
  const { fullname, phone } = req.body;
  try {
    await pool.query(
      `UPDATE users SET fullname = COALESCE($1, fullname), phone = COALESCE($2, phone) WHERE id = $3`,
      [fullname, phone, req.user.id]
    );
    res.json({ message: 'Profile updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// CHANGE email (requires current password)
router.post('/change-email', verifyToken, async (req, res) => {
  const { newEmail, currentPassword } = req.body;
  if (!newEmail || !currentPassword) return res.status(400).json({ error: 'New email and current password required' });
  try {
    const user = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const existing = await pool.query(`SELECT id FROM users WHERE email = $1 AND id != $2`, [newEmail, req.user.id]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already in use' });
    await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [newEmail, req.user.id]);
    res.json({ message: 'Email updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

// CHANGE password
router.post('/change-password', verifyToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Missing passwords' });
  try {
    const user = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(oldPassword, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashed, req.user.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// For drivers – get approval status and extra info
router.get('/driver-info', verifyToken, async (req, res) => {
  if (req.user.role !== 'driver') return res.status(403).json({ error: 'Not a driver' });
  try {
    const driver = await pool.query(
      `SELECT is_approved, plate_number, vehicle_type, rating_avg FROM drivers WHERE user_id = $1`,
      [req.user.id]
    );
    res.json(driver.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// UPDATE avatar URL
router.put('/avatar', verifyToken, async (req, res) => {
  const { avatarUrl } = req.body;
  if (!avatarUrl) return res.status(400).json({ error: 'Avatar URL required' });
  try {
    await pool.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [avatarUrl, req.user.id]);
    res.json({ message: 'Avatar updated', avatarUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update avatar' });
  }
});

module.exports = router;