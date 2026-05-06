const express = require('express');
const pool = require('../models/db');
const { verifyToken, isAdmin } = require('../middleware/auth');
const router = express.Router();

// Get all users
router.get('/users', verifyToken, isAdmin, async (req, res) => {
  const users = await pool.query(`SELECT id, fullname, email, role, phone, created_at FROM users`);
  res.json(users.rows);
});

// Get all rides
router.get('/rides', verifyToken, isAdmin, async (req, res) => {
  const rides = await pool.query(`
    SELECT r.*, 
      c.fullname as commuter_name, 
      d_user.fullname as driver_name
    FROM ride_requests r
    LEFT JOIN users c ON r.commuter_id = c.id
    LEFT JOIN drivers d ON r.driver_id = d.user_id
    LEFT JOIN users d_user ON d.user_id = d_user.id
    ORDER BY r.created_at DESC
  `);
  res.json(rides.rows);
});

// Get pending drivers (unapproved)
router.get('/pending-drivers', verifyToken, isAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT u.id, u.fullname, u.email, u.phone, d.plate_number, d.id_photo_path, d.selfie_path, d.submitted_at
    FROM drivers d
    JOIN users u ON d.user_id = u.id
    WHERE d.is_approved = false
    ORDER BY d.submitted_at ASC
  `);
  res.json(result.rows);
});

// Approve a driver
router.put('/approve-driver/:userId', verifyToken, isAdmin, async (req, res) => {
  const { userId } = req.params;
  await pool.query(`UPDATE drivers SET is_approved = true WHERE user_id = $1`, [userId]);
  res.json({ message: 'Driver approved successfully' });
});

// Reject a driver (delete the driver and user)
router.delete('/reject-driver/:userId', verifyToken, isAdmin, async (req, res) => {
  const { userId } = req.params;
  await pool.query(`DELETE FROM drivers WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  res.json({ message: 'Driver rejected and removed' });
});

module.exports = router;