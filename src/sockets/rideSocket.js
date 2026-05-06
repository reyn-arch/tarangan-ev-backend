const pool = require('../models/db');

const activeDrivers = new Map(); // driverId -> socket.id
const driverSockets = new Map(); // socket.id -> driverId (reverse)

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

module.exports.setupSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('registerUser', (userId) => {
      socket.join(`user_${userId}`);
    });

    socket.on('driverOnline', async (driverId, lat, lng) => {
      activeDrivers.set(driverId, socket.id);
      driverSockets.set(socket.id, driverId);
      await pool.query(
        `UPDATE drivers SET is_online = true, current_lat = $1, current_lng = $2 WHERE user_id = $3`,
        [lat, lng, driverId]
      );
      socket.join(`driver_${driverId}`);
    });

    socket.on('driverLocation', async (driverId, lat, lng) => {
      await pool.query(
        `UPDATE drivers SET current_lat = $1, current_lng = $2 WHERE user_id = $3`,
        [lat, lng, driverId]
      );
    });

    socket.on('requestRide', async (data, callback) => {
      const { commuterId, pickup, dropoff, pickupAddr, dropoffAddr, commuterName } = data;
      try {
        const result = await pool.query(
          `INSERT INTO ride_requests 
           (commuter_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, pickup_address, dropoff_address, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'searching') RETURNING id`,
          [commuterId, pickup.lat, pickup.lng, dropoff.lat, dropoff.lng, pickupAddr, dropoffAddr]
        );
        const rideId = result.rows[0].id;

        // Find nearby online drivers (within 5 km)
        const driversQuery = await pool.query(`
          SELECT d.user_id, u.fullname, d.current_lat, d.current_lng
          FROM drivers d
          JOIN users u ON d.user_id = u.id
          WHERE d.is_online = true
        `);
        const nearby = [];
        for (let driver of driversQuery.rows) {
          const dist = getDistance(pickup.lat, pickup.lng, driver.current_lat, driver.current_lng);
          if (dist <= 5) {
            nearby.push({ ...driver, distance: dist });
          }
        }
        // Sort by distance
        nearby.sort((a,b) => a.distance - b.distance);
        // Send to top 5 nearest drivers
        const notified = nearby.slice(0,5);
        for (let driver of notified) {
          const driverSocketId = activeDrivers.get(driver.user_id);
          if (driverSocketId) {
            io.to(driverSocketId).emit('newRideRequest', {
              rideId,
              pickupAddr,
              commuterName,
              distance: Math.round(driver.distance * 100) / 100
            });
          }
        }

        // Auto-cancel after 50 seconds if no driver accepts
        setTimeout(async () => {
          const check = await pool.query(`SELECT status FROM ride_requests WHERE id = $1`, [rideId]);
          if (check.rows[0] && check.rows[0].status === 'searching') {
            await pool.query(`UPDATE ride_requests SET status = 'cancelled' WHERE id = $1`, [rideId]);
            io.to(`user_${commuterId}`).emit('rideExpired', { rideId });
          }
        }, 50000);

        callback({ rideId, status: 'searching' });
      } catch (err) {
        console.error(err);
        callback({ error: 'Failed to request ride' });
      }
    });

    socket.on('acceptRide', async ({ rideId, driverId }) => {
      try {
        const ride = await pool.query(`SELECT commuter_id, status FROM ride_requests WHERE id = $1`, [rideId]);
        if (ride.rows.length === 0) return socket.emit('acceptFailed', { message: 'Ride not found' });
        if (ride.rows[0].status !== 'searching') {
          return socket.emit('acceptFailed', { message: 'Ride already taken or cancelled' });
        }
        await pool.query(
          `UPDATE ride_requests SET driver_id = $1, status = 'accepted', accepted_at = NOW() WHERE id = $2`,
          [driverId, rideId]
        );
        const commuterId = ride.rows[0].commuter_id;
        // Notify commuter
        io.to(`user_${commuterId}`).emit('rideAccepted', { rideId, driverId });
        // Notify driver of success
        socket.emit('rideAcceptedConfirm', { rideId });
      } catch (err) {
        console.error(err);
        socket.emit('acceptFailed', { message: 'Server error' });
      }
    });

    socket.on('updateRideStatus', async ({ rideId, driverId, status }) => {
      // Similar to API but over socket for real-time
      const ride = await pool.query(`SELECT * FROM ride_requests WHERE id = $1`, [rideId]);
      if (ride.rows.length && ride.rows[0].driver_id === driverId) {
        await pool.query(`UPDATE ride_requests SET status = $1 WHERE id = $2`, [status, rideId]);
        const commuterId = ride.rows[0].commuter_id;
        io.to(`user_${commuterId}`).emit('rideStatusUpdate', { rideId, status });
      }
    });

    socket.on('disconnect', async () => {
      const driverId = driverSockets.get(socket.id);
      if (driverId) {
        activeDrivers.delete(driverId);
        driverSockets.delete(socket.id);
        await pool.query(`UPDATE drivers SET is_online = false WHERE user_id = $1`, [driverId]);
      }
      console.log('Socket disconnected:', socket.id);
    });
  });
};