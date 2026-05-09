const pool = require('../models/db');

const activeDrivers = new Map();   // driverId -> socket.id
const driverLocations = new Map(); // driverId -> { lat, lng, fullname, plate, rating }
const commuterSubscriptions = new Map(); // commuterId -> { timeoutId, radius?, etc. }

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*
            Math.sin(dLon/2)*Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Helper to get driver details from DB (for first load)
async function getDriverDetails(driverId) {
  const result = await pool.query(
    `SELECT u.fullname, d.plate_number, d.rating_avg, d.current_lat, d.current_lng
     FROM drivers d JOIN users u ON d.user_id = u.id
     WHERE d.user_id = $1`,
    [driverId]
  );
  if (result.rows.length) return result.rows[0];
  return null;
}

module.exports.setupSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    // Register commuter (subscribe to nearby drivers)
    socket.on('subscribeDrivers', async (commuterId, lat, lng, radius = 3) => {
      socket.join(`commuter_${commuterId}`);
      // Send initial list of nearby drivers
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
            distance: dist
          });
        }
      }
      socket.emit('nearbyDrivers', driversList);
      // Store subscription for later updates (optional)
      commuterSubscriptions.set(commuterId, { lat, lng, radius });
    });

    // Driver online
    socket.on('driverOnline', async (driverId, lat, lng) => {
      activeDrivers.set(driverId, socket.id);
      const details = await getDriverDetails(driverId);
      driverLocations.set(driverId, {
        lat, lng,
        fullname: details?.fullname || 'Driver',
        plate: details?.plate_number || '',
        rating: details?.rating_avg || 0
      });
      await pool.query(`UPDATE drivers SET is_online = true, current_lat = $1, current_lng = $2 WHERE user_id = $3`,
        [lat, lng, driverId]);
      socket.join(`driver_${driverId}`);

      // Broadcast this driver to all nearby commuters
      for (let [commuterId, sub] of commuterSubscriptions.entries()) {
        const dist = getDistance(sub.lat, sub.lng, lat, lng);
        if (dist <= sub.radius) {
          io.to(`commuter_${commuterId}`).emit('driverLocationUpdate', {
            driverId,
            lat, lng,
            fullname: details.fullname,
            plate: details.plate_number,
            rating: details.rating_avg
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
      await pool.query(`UPDATE drivers SET current_lat = $1, current_lng = $2 WHERE user_id = $3`,
        [lat, lng, driverId]);
      // Broadcast to nearby commuters
      for (let [commuterId, sub] of commuterSubscriptions.entries()) {
        const dist = getDistance(sub.lat, sub.lng, lat, lng);
        if (dist <= sub.radius) {
          io.to(`commuter_${commuterId}`).emit('driverLocationUpdate', {
            driverId, lat, lng,
            fullname: driverLocations.get(driverId)?.fullname,
            plate: driverLocations.get(driverId)?.plate,
            rating: driverLocations.get(driverId)?.rating
          });
        }
      }
    });

    // Ride request with sequential driver notification (nearest first, 30 sec timeout per driver)
    socket.on('requestRide', async (data, callback) => {
      const { commuterId, pickup, dropoff, pickupAddr, dropoffAddr, commuterName } = data;
      // Insert ride request
      const result = await pool.query(
        `INSERT INTO ride_requests (commuter_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, pickup_address, dropoff_address, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'searching') RETURNING id`,
        [commuterId, pickup.lat, pickup.lng, dropoff.lat, dropoff.lng, pickupAddr, dropoffAddr]
      );
      const rideId = result.rows[0].id;

      // Get all online drivers with current location
      const drivers = [];
      for (let [driverId, loc] of driverLocations.entries()) {
        const dist = getDistance(pickup.lat, pickup.lng, loc.lat, loc.lng);
        drivers.push({ driverId, distance: dist, socketId: activeDrivers.get(driverId), ...loc });
      }
      drivers.sort((a,b) => a.distance - b.distance);
      
      let driverIndex = 0;
      let accepted = false;
      let timeoutIds = [];

      const tryNextDriver = () => {
        if (accepted || driverIndex >= drivers.length) {
          if (!accepted) {
            // No driver accepted, cancel ride
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
        // Notify this driver
        io.to(driver.socketId).emit('newRideRequest', {
          rideId,
          pickupAddr,
          commuterName,
          distance: Math.round(driver.distance * 100) / 100
        });
        // Set timeout for this driver (30 seconds)
        const tid = setTimeout(async () => {
          if (!accepted) {
            // move to next driver
            driverIndex++;
            tryNextDriver();
          }
        }, 30000);
        timeoutIds.push(tid);
      };

      // Listen for accept from any driver
      const acceptHandler = async ({ rideId: acceptedId, driverId }) => {
        if (acceptedId !== rideId) return;
        if (accepted) return;
        accepted = true;
        // Clear all pending timeouts
        timeoutIds.forEach(tid => clearTimeout(tid));
        // Update ride status
        await pool.query(`UPDATE ride_requests SET driver_id = $1, status = 'accepted', accepted_at = NOW() WHERE id = $2`,
          [driverId, rideId]);
        // Notify commuter
        const driverDetails = driverLocations.get(driverId) || {};
        io.to(`commuter_${commuterId}`).emit('rideAccepted', {
          rideId,
          driverId,
          driverName: driverDetails.fullname,
          driverPlate: driverDetails.plate,
          driverRating: driverDetails.rating
        });
        // Notify driver
        const driverSocket = activeDrivers.get(driverId);
        if (driverSocket) io.to(driverSocket).emit('rideAcceptedConfirm', { rideId });
      };

      socket.once('acceptRide', acceptHandler);
      // Start with first driver
      tryNextDriver();

      // Cleanup if commuter disconnects
      socket.on('disconnect', () => {
        if (!accepted) {
          timeoutIds.forEach(tid => clearTimeout(tid));
          pool.query(`UPDATE ride_requests SET status = 'cancelled' WHERE id = $1`, [rideId]);
        }
        socket.off('acceptRide', acceptHandler);
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
        // Notify commuters that this driver went offline
        for (let [commuterId, sub] of commuterSubscriptions.entries()) {
          io.to(`commuter_${commuterId}`).emit('driverOffline', { driverId });
        }
      }
    });
  });
};