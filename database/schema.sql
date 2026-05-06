CREATE DATABASE taran_gan_hailing;

\c taran_gan_hailing;

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  fullname VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) CHECK (role IN ('commuter','driver','admin')) NOT NULL,
  phone VARCHAR(20),
  profile_photo TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE drivers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type VARCHAR(50) DEFAULT 'Electric L2B',
  plate_number VARCHAR(20),
  is_online BOOLEAN DEFAULT false,
  current_lat DECIMAL(10,8),
  current_lng DECIMAL(11,8),
  rating_avg DECIMAL(2,1) DEFAULT 0,
  total_trips INTEGER DEFAULT 0,
  battery_level INTEGER DEFAULT 100
);

CREATE TABLE ride_requests (
  id SERIAL PRIMARY KEY,
  commuter_id INTEGER REFERENCES users(id),
  pickup_lat DECIMAL(10,8),
  pickup_lng DECIMAL(11,8),
  dropoff_lat DECIMAL(10,8),
  dropoff_lng DECIMAL(11,8),
  pickup_address TEXT,
  dropoff_address TEXT,
  status VARCHAR(20) DEFAULT 'searching',
  driver_id INTEGER REFERENCES drivers(user_id),
  created_at TIMESTAMP DEFAULT NOW(),
  accepted_at TIMESTAMP,
  completed_at TIMESTAMP,
  fare DECIMAL(8,2),
  CONSTRAINT valid_status CHECK (status IN ('searching','accepted','arrived','started','completed','cancelled'))
);

CREATE TABLE ratings (
  id SERIAL PRIMARY KEY,
  ride_id INTEGER REFERENCES ride_requests(id),
  from_user_id INTEGER REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title VARCHAR(100),
  message TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Insert a default admin (password = admin123)
INSERT INTO users (fullname, email, password_hash, role) 
VALUES ('Admin', 'admin@taran.com', '$2a$10$N9qo8uLOickgx2ZMRZoMy.Mr/.qZqVfL5qF6FyWgCqZqZqZqZqZq', 'admin');
-- (hash is for "admin123", you can change later)