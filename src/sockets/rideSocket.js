const pool = require('../models/db');

const activeDrivers = new Map();      // driverId -> socket.id
const driverLocations = new Map();    // driverId -> location data
const commuterSubscriptions = new Map(); // commuterId -> { lat, lng, radius }
const pendingRides = new Map();       // rideId -> { commuterId, timeouts, accepted }

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

async function getDriverDetails(driverId) {
  const res = await pool.query(
    `SELECT u.fullname, u.avatar_url, d.plate_number, d.rating_avg
     FROM drivers d JOIN users u ON d.user_id = u.id
     WHERE d.user_id = $1`,
    [driverId]
  );
  return res.rows[0];
}

module.exports.setupSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    // Register user to a room
    socket.on('registerUser', (userId) => socket.join(`user_${userId}`));

    // Commuter subscribes to nearby drivers
    socket.on('subscribeDrivers', (commuterId, lat, lng, radius = 5) => {
      socket.join(`commuter_${commuterId}`);
      commuterSubscriptions.set(commuterId, { lat, lng, radius });
      const driversList = [];
      for (let [driverId, loc] of driverLocations.entries()) {
        const dist = getDistance(lat, lng, loc.lat, loc.lng);
        if (dist <= radius) {
          driversList.push({
            driverId,
            lat: loc.lat, lng: loc.lng,
            fullname: loc.fullname,
            plate: loc.plate,
            rating: loc.rating,
            avatarUrl: loc.avatarUrl,
            distance: dist
          });
        }
      }
      socket.emit('nearbyDrivers', driversList);
    });

    // Driver goes online
    socket.on('driverOnline', async (driverId, lat, lng) => {
      console.log(`[ONLINE] Driver ${driverId} at ${lat}, ${lng}`);
      activeDrivers.set(driverId, socket.id);
      const details = await getDriverDetails(driverId);
      driverLocations.set(driverId, {
        lat, lng,
        fullname: details?.fullname || 'Driver',
        plate: details?.plate_number || '',
        rating: details?.rating_avg || 0,
        avatarUrl: details?.avatar_url || null
      });
      await pool.query(
        `UPDATE drivers SET is_online = true, current_lat = $1, current_lng = $2 WHERE user_id = $3`,
        [lat, lng, driverId]
      );
      socket.join(`driver_${driverId}`);
      // Notify all commuters about the new driver
      for (const [commuterId, sub] of commuterSubscriptions.entries()) {
        const dist = getDistance(sub.lat, sub.lng, lat, lng);
        if (dist <= sub.radius) {
          io.to(`commuter_${commuterId}`).emit('driverLocationUpdate', {
            driverId, lat, lng,
            fullname: driverLocations.get(driverId).fullname,
            plate: driverLocations.get(driverId).plate,
            rating: driverLocations.get(driverId).rating,
            avatarUrl: driverLocations.get(driverId).avatarUrl
          });
        }
      }
    });

    // Driver location update
    socket.on('driverLocation', async (driverId, lat, lng) => {
      if (!driverLocations.has(driverId)) return;
      driverLocations.set(driverId, { ...driverLocations.get(driverId), lat, lng });
      await pool.query(
        `UPDATE drivers SET current_lat = $1, current_lng = $2 WHERE user_id = $3`,
        [lat, lng, driverId]
      );
      for (const [commuterId, sub] of commuterSubscriptions.entries()) {
        const dist = getDistance(sub.lat, sub.lng, lat, lng);
        if (dist <= sub.radius) {
          io.to(`commuter_${commuterId}`).emit('driverLocationUpdate', {
            driverId, lat, lng,
            fullname: driverLocations.get(driverId).fullname,
            plate: driverLocations.get(driverId).plate,
            rating: driverLocations.get(driverId).rating,
            avatarUrl: driverLocations.get(driverId).avatarUrl
          });
        }
      }
    });

    // Commuter requests a ride
    socket.on('requestRide', async (data, callback) => {
      const { commuterId, pickup, dropoff, pickupAddr, dropoffAddr, commuterName } = data;

      // Create ride request in DB
      const result = await pool.query(
        `INSERT INTO ride_requests (commuter_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, pickup_address, dropoff_address, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'searching') RETURNING id`,
        [commuterId, pickup.lat, pickup.lng, dropoff.lat, dropoff.lng, pickupAddr, dropoffAddr]
      );
      const rideId = result.rows[0].id;

      // Get sorted drivers by distance
      const drivers = [];
      for (let [driverId, loc] of driverLocations.entries()) {
        const dist = getDistance(pickup.lat, pickup.lng, loc.lat, loc.lng);
        drivers.push({ driverId, distance: dist, socketId: activeDrivers.get(driverId), ...loc });
      }
      drivers.sort((a,b) => a.distance - b.distance);

      let driverIndex = 0;
      let accepted = false;
      const timeouts = [];

      const notifyNextDriver = () => {
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
          notifyNextDriver();
          return;
        }
        // Send request to this driver
        io.to(driver.socketId).emit('newRideRequest', {
          rideId,
          pickupAddr,
          commuterName,
          distance: Math.round(driver.distance * 100) / 100
        });
        // Set timeout (30 sec) for this driver to respond
        const tid = setTimeout(() => {
          if (!accepted) {
            driverIndex++;
            notifyNextDriver();
          }
        }, 30000);
        timeouts.push(tid);
      };

      // Store pending ride info for later acceptance
      pendingRides.set(rideId, {
        commuterId,
        timeouts,
        accepted: false,
        driversList: drivers.map(d => d.driverId)
      });

      // Start notification chain
      notifyNextDriver();

      callback({ rideId, status: 'searching' });
    });

    // Driver accepts a ride – GLOBAL handler
    socket.on('acceptRide', async ({ rideId, driverId }) => {
      console.log(`🔵 ACCEPT RIDE: rideId=${rideId}, driverId=${driverId}`);
      const ride = pendingRides.get(rideId);
      if (!ride || ride.accepted) {
        console.log(`Ride ${rideId} not pending or already accepted`);
        return;
      }

      // Mark as accepted
      ride.accepted = true;
      ride.timeouts.forEach(tid => clearTimeout(tid));
      pendingRides.delete(rideId);

      // Update database
      await pool.query(
        `UPDATE ride_requests SET driver_id = $1, status = 'accepted', accepted_at = NOW() WHERE id = $2`,
        [driverId, rideId]
      );

      // Get driver details
      const driver = driverLocations.get(driverId) || {};
      // Notify commuter
      io.to(`commuter_${ride.commuterId}`).emit('rideAccepted', {
        rideId,
        driverId,
        driverName: driver.fullname,
        driverPlate: driver.plate,
        driverRating: driver.rating
      });
      // Confirm to driver (use the driver's socket)
      const driverSocketId = activeDrivers.get(driverId);
      if (driverSocketId) {
        io.to(driverSocketId).emit('rideAcceptedConfirm', { rideId });
      }
      console.log(`✅ Ride ${rideId} accepted by driver ${driverId}`);
    });

    // Driver offline
    socket.on('disconnect', async () => {
      let driverId = null;
      for (let [id, sid] of activeDrivers.entries()) {
        if (sid === socket.id) driverId = id;
      }
      if (driverId) {
        activeDrivers.delete(driverId);
        driverLocations.delete(driverId);
        await pool.query(`UPDATE drivers SET is_online = false WHERE user_id = $1`, [driverId]);
        // Notify commuters
        for (const [commuterId, sub] of commuterSubscriptions.entries()) {
          io.to(`commuter_${commuterId}`).emit('driverOffline', { driverId });
        }
      }
    });
  });
};