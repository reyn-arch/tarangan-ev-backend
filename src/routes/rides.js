const express = require('express');
const pool = require('../models/db');
const { verifyToken } = require('../middleware/auth');
const router = express.Router();

// Get ride history for a user
router.get('/history/:userId', verifyToken, async (req, res) => {
  const { userId } = req.params;
  if (req.user.id != userId && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const rides = await pool.query(
    `SELECT r.*, 
      u_commuter.fullname as commuter_name,
      u_driver.fullname as driver_name,
      d.plate_number
     FROM ride_requests r
     LEFT JOIN users u_commuter ON r.commuter_id = u_commuter.id
     LEFT JOIN drivers d ON r.driver_id = d.user_id
     LEFT JOIN users u_driver ON d.user_id = u_driver.id
     WHERE r.commuter_id = $1 OR r.driver_id = $1
     ORDER BY r.created_at DESC`,
    [userId]
  );
  res.json(rides.rows);
});

// Update ride status (driver side)
router.post('/update-status', verifyToken, async (req, res) => {
  const { rideId, status } = req.body;
  const allowed = ['accepted', 'arrived', 'started', 'completed', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const ride = await pool.query(`SELECT * FROM ride_requests WHERE id = $1`, [rideId]);
  if (ride.rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
  if (ride.rows[0].driver_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  let updateData = { status };
  if (status === 'completed') updateData.completed_at = new Date();
  await pool.query(
    `UPDATE ride_requests SET status = $1, completed_at = COALESCE($2, completed_at) WHERE id = $3`,
    [status, updateData.completed_at || null, rideId]
  );
  res.json({ success: true });
});

// Submit rating & feedback
router.post('/rate', verifyToken, async (req, res) => {
  const { rideId, rating, comment } = req.body;
  const ride = await pool.query(`SELECT * FROM ride_requests WHERE id = $1`, [rideId]);
  if (ride.rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
  const toUserId = ride.rows[0].driver_id;
  await pool.query(
    `INSERT INTO ratings (ride_id, from_user_id, to_user_id, rating, comment) VALUES ($1,$2,$3,$4,$5)`,
    [rideId, req.user.id, toUserId, rating, comment]
  );
  // Update driver average rating
  const avg = await pool.query(
    `SELECT AVG(rating) as avg FROM ratings WHERE to_user_id = $1`,
    [toUserId]
  );
  await pool.query(`UPDATE drivers SET rating_avg = $1 WHERE user_id = $2`, [avg.rows[0].avg, toUserId]);
  res.json({ success: true });
});

module.exports = router;