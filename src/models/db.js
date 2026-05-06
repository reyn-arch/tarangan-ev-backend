const { Pool } = require('pg');
require('dotenv').config();

let poolConfig;
if (process.env.DATABASE_URL) {
  // Production (Render)
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  };
} else {
  // Local development
  poolConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    port: 5432,
  };
}
const pool = new Pool(poolConfig);
module.exports = pool;