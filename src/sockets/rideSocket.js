const pool = require('../models/db');

const activeDrivers = new Map();
const driverLocations = new Map();
const commuterSubscriptions = new Map();

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getDriverDetails(driverId) {
  const result = await pool.query(
    `SELECT u.fullname, u.avatar_url, d.plate_number, d.rating_avg, d.current_lat, d.current_lng
     FROM drivers d JOIN users u ON d.user_id = u.id
     WHERE d.user_id = $1`,
    [driverId]
  );
  return result.rows[0];
}

module.exports.setupSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    // Register user
    socket.on('registerUser', (userId) => {
      socket.join(`user_${userId}`);
    });

    // Commuter subscribes to nearby drivers
    socket.on('subscribeDrivers', (commuterId, lat, lng, radius = 3) => {
      socket.join(`commuter_${commuterId}`);
      const driversList = [];
      for (let [driverId, loc] of driverLocations.entries()) {
        const dist = getDistance(lat, lng, loc.lat, loc.lng);
        if (dist <= radius) {
          driversList.push({
            driverId,
            lat: loc.lat,
            lng: loc.lng,
            fullname: loc.fullname,
            plate: loc.plate,
            rating: loc.rating,
            distance: dist,
            avatarUrl: loc.avatarUrl
          });
        }
      }
      socket.emit('nearbyDrivers', driversList);
      commuterSubscriptions.set(commuterId, { lat, lng, radius });
    });

    // Driver goes online
    socket.on('driverOnline', async (driverId, lat, lng) => {
      activeDrivers.set(driverId, socket.id);
      const details = await getDriverDetails(driverId);
      driverLocations.set(driverId, {
        lat, lng,
        fullname: details?.fullname || 'Driver',
        plate: details?.plate_number || '',
        rating: parseFloat(details?.rating_avg) || 0,
        avatarUrl: details?.avatar_url || null
      });
      await pool.query(
        `UPDATE drivers SET is_online = true, current_lat = $1, current_lng = $2 WHERE user_id = $3`,
        [lat, lng, driverId]
      );
      socket.join(`driver_${driverId}`);
      // Broadcast new driver to all nearby commuters
      for (let [commuterId, sub] of commuterSubscriptions.entries()) {
        const dist = getDistance(sub.lat, sub.lng, lat, lng);
        if (dist <= sub.radius) {
          io.to(`commuter_${commuterId}`).emit('driverLocationUpdate', {
            driverId,
            lat, lng,
            fullname: driverLocations.get(driverId)?.fullname,
            plate: driverLocations.get(driverId)?.plate,
            rating: driverLocations.get(driverId)?.rating,
            avatarUrl: driverLocations.get(driverId)?.avatarUrl
          });
        }
      }
    });

    // Driver location update
    socket.on('driverLocation', async (driverId, lat, lng) => {
      if (driverLocations.has(driverId)) {
        const old = driverLocations.get(driverId);
        driverLocations.set(driverId, { ...old, lat, lng });
      }
      await pool.query(
        `UPDATE drivers SET current_lat = $1, current_lng = $2 WHERE user_id = $3`,
        [lat, lng, driverId]
      );
      for (let [commuterId, sub] of commuterSubscriptions.entries()) {
        const dist = getDistance(sub.lat, sub.lng, lat, lng);
        if (dist <= sub.radius) {
          io.to(`commuter_${commuterId}`).emit('driverLocationUpdate', {
            driverId, lat, lng,
            fullname: driverLocations.get(driverId)?.fullname,
            plate: driverLocations.get(driverId)?.plate,
            rating: driverLocations.get(driverId)?.rating,
            avatarUrl: driverLocations.get(driverId)?.avatarUrl
          });
        }
      }
    });

    // Global acceptRide handler (listens once per ride request via a unique event?)
    // Instead, we'll use a one-time listener per ride request, but we need to store the handler.
    // The proper way: inside requestRide, we'll set a one-time listener that will be removed after accept or timeout.
    // We'll also handle disconnection.

    socket.on('requestRide', async (data, callback) => {
      const { commuterId, pickup, dropoff, pickupAddr, dropoffAddr, commuterName } = data;
      const result = await pool.query(
        `INSERT INTO ride_requests (commuter_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, pickup_address, dropoff_address, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'searching') RETURNING id`,
        [commuterId, pickup.lat, pickup.lng, dropoff.lat, dropoff.lng, pickupAddr, dropoffAddr]
      );
      const rideId = result.rows[0].id;

      const drivers = [];
      for (let [driverId, loc] of driverLocations.entries()) {
        const dist = getDistance(pickup.lat, pickup.lng, loc.lat, loc.lng);
        drivers.push({ driverId, distance: dist, socketId: activeDrivers.get(driverId), ...loc });
      }
      drivers.sort((a, b) => a.distance - b.distance);

      let driverIndex = 0;
      let accepted = false;
      let timeoutIds = [];

      const tryNextDriver = () => {
        if (accepted || driverIndex >= drivers.length) {
          if (!accepted) {
            pool.query(`UPDATE ride_requests SET status = 'cancelled' WHERE id = $1`, [rideId]);
            io.to(`commuter_${commuterId}`).emit('rideExpired', { rideId });
          }
          return;
        }
        const driver = drivers[driverIndex];
        if (!driver.socketId) {
          driverIndex++;
          tryNextDriver();
          return;
        }
        io.to(driver.socketId).emit('newRideRequest', {
          rideId,
          pickupAddr,
          commuterName,
          distance: Math.round(driver.distance * 100) / 100
        });
        const tid = setTimeout(() => {
          if (!accepted) {
            driverIndex++;
            tryNextDriver();
          }
        }, 30000);
        timeoutIds.push(tid);
      };

      // One-time accept handler for this ride request
      const acceptRideHandler = async ({ rideId: acceptedId, driverId }) => {
        if (acceptedId !== rideId || accepted) return;
        accepted = true;
        timeoutIds.forEach(id => clearTimeout(id));
        await pool.query(`UPDATE ride_requests SET driver_id = $1, status = 'accepted', accepted_at = NOW() WHERE id = $2`, [driverId, rideId]);
        const driverDetails = driverLocations.get(driverId) || {};
        io.to(`commuter_${commuterId}`).emit('rideAccepted', {
          rideId,
          driverId,
          driverName: driverDetails.fullname,
          driverPlate: driverDetails.plate,
          driverRating: driverDetails.rating
        });
        const driverSocket = activeDrivers.get(driverId);
        if (driverSocket) io.to(driverSocket).emit('rideAcceptedConfirm', { rideId });
      };

      socket.once('acceptRide', acceptRideHandler);
      tryNextDriver();

      // Cleanup on disconnect
      socket.on('disconnect', () => {
        if (!accepted) {
          timeoutIds.forEach(id => clearTimeout(id));
          pool.query(`UPDATE ride_requests SET status = 'cancelled' WHERE id = $1`, [rideId]);
        }
        socket.off('acceptRide', acceptRideHandler);
      });

      callback({ rideId, status: 'searching' });
    });

    // Driver disconnect
    socket.on('disconnect', async () => {
      let driverId = null;
      for (let [id, sid] of activeDrivers.entries()) if (sid === socket.id) driverId = id;
      if (driverId) {
        activeDrivers.delete(driverId);
        driverLocations.delete(driverId);
        await pool.query(`UPDATE drivers SET is_online = false WHERE user_id = $1`, [driverId]);
        for (let [commuterId, sub] of commuterSubscriptions.entries()) {
          io.to(`commuter_${commuterId}`).emit('driverOffline', { driverId });
        }
      }
    });
  });
};