const express = require('express');
const pool = require('../models/db');
const nodemailer = require('nodemailer');
const { verifyToken, isAdmin } = require('../middleware/auth');
const router = express.Router();

// Configure nodemailer transporter (same as in auth.js)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Helper function to send email
async function sendDriverNotification(email, fullname, status, reason = '') {
  const subject = status === 'approved' 
    ? 'Your driver registration has been approved!' 
    : 'Your driver registration has been rejected';
  
  const text = status === 'approved'
    ? `Hello ${fullname},\n\nCongratulations! Your driver account has been approved. You can now log in to the EV Hailing app and start accepting ride requests.\n\nThank you for joining our electric fleet!`
    : `Hello ${fullname},\n\nWe regret to inform you that your driver registration has been rejected.\n\nReason: ${reason || 'Your application did not meet our requirements.'}\n\nYou may contact support for more information.`;

  const html = status === 'approved'
    ? `<h3>Hello ${fullname},</h3><p>Congratulations! Your driver account has been <strong>approved</strong>. You can now log in to the EV Hailing app and start accepting ride requests.</p><p>Thank you for joining our electric fleet!</p>`
    : `<h3>Hello ${fullname},</h3><p>We regret to inform you that your driver registration has been <strong>rejected</strong>.</p><p>Reason: ${reason || 'Your application did not meet our requirements.'}</p><p>You may contact support for more information.</p>`;

  await transporter.sendMail({
    from: `"EV-HAIL-LABS" <${process.env.SMTP_FROM}>`,
    to: email,
    subject: subject,
    text: text,
    html: html,
  });
}

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

// Approve a driver – sends email notification
router.put('/approve-driver/:userId', verifyToken, isAdmin, async (req, res) => {
  const { userId } = req.params;
  
  // Get driver email and name before approving
  const driverInfo = await pool.query(
    `SELECT u.email, u.fullname FROM users u JOIN drivers d ON u.id = d.user_id WHERE u.id = $1`,
    [userId]
  );
  
  if (driverInfo.rows.length === 0) {
    return res.status(404).json({ error: 'Driver not found' });
  }
  
  await pool.query(`UPDATE drivers SET is_approved = true WHERE user_id = $1`, [userId]);
  
  // Send approval email (don't await to avoid blocking response)
  sendDriverNotification(driverInfo.rows[0].email, driverInfo.rows[0].fullname, 'approved').catch(err => console.error('Email error:', err));
  
  res.json({ message: 'Driver approved successfully. Email notification sent.' });
});

// Reject a driver (delete the driver and user) – sends email notification
router.delete('/reject-driver/:userId', verifyToken, isAdmin, async (req, res) => {
  const { userId } = req.params;
  
  // Get driver email and name before deleting
  const driverInfo = await pool.query(
    `SELECT u.email, u.fullname FROM users u JOIN drivers d ON u.id = d.user_id WHERE u.id = $1`,
    [userId]
  );
  
  if (driverInfo.rows.length === 0) {
    return res.status(404).json({ error: 'Driver not found' });
  }
  
  const { email, fullname } = driverInfo.rows[0];
  
  // You can also accept a reason from request body if you add a field in the frontend
  const reason = req.body.reason || 'Your application did not meet our requirements.';
  
  await pool.query(`DELETE FROM drivers WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  
  // Send rejection email
  sendDriverNotification(email, fullname, 'rejected', reason).catch(err => console.error('Email error:', err));
  
  res.json({ message: 'Driver rejected and removed. Email notification sent.' });
});

module.exports = router;