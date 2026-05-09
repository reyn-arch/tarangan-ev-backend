require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const authRoutes = require('./routes/auth');
const rideRoutes = require('./routes/rides');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/users');          // <-- import
const { setupSocketHandlers } = require('./sockets/rideSocket');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('Created uploads directory');
}

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Routes – order doesn't matter as long as they are after app.use(...)
app.use('/api/auth', authRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);                    // <-- register AFTER app is defined

setupSocketHandlers(io);

server.listen(process.env.PORT || 5000, () => {
  console.log(`Backend running on port ${process.env.PORT}`);
});