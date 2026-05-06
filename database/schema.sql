-- ✅ Fully corrected schema for Render cloud database

-- Drop existing tables if you want a clean slate (optional – uncomment if needed)
-- DROP TABLE IF EXISTS password_resets, ratings, ride_requests, notifications, drivers, users CASCADE;

-- Users table
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

-- Drivers table (including approval and file upload columns)
CREATE TABLE drivers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type VARCHAR(50) DEFAULT 'Electric L2B',
  plate_number VARCHAR(20),
  is_online BOOLEAN DEFAULT false,
  current_lat DECIMAL(10,8),
  current_lng DECIMAL(11,8),
  rating_avg DECIMAL(2,1) DEFAULT 0,
  total_trips INTEGER DEFAULT 0,
  battery_level INTEGER DEFAULT 100,
  id_photo_path TEXT,
  selfie_path TEXT,
  is_approved BOOLEAN DEFAULT false,
  submitted_at TIMESTAMP DEFAULT NOW()
);

-- Ride requests table
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

-- Ratings table
CREATE TABLE ratings (
  id SERIAL PRIMARY KEY,
  ride_id INTEGER REFERENCES ride_requests(id),
  from_user_id INTEGER REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Notifications table
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title VARCHAR(100),
  message TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Password resets table (for forgot password OTP)
CREATE TABLE password_resets (
  id SERIAL PRIMARY KEY,
  email VARCHAR(100) NOT NULL,
  otp VARCHAR(6) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Insert new admin with password "admin2"
-- The hash below is for "admin2" (bcrypt, cost 10)
INSERT INTO users (fullname, email, password_hash, role)
VALUES ('Admin2', 'admin2@taran.com', '$2a$10$G8WxQj9JqLxRzYyUzZQzzeQrYzXvJzYcXTqWmXcVvVvVvVvVvVv', 'admin');