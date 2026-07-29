require('dotenv').config();
const sql = require('mssql');

const baseConfig = {
  server: process.env.DB_SERVER || 'localhost',
  port: Number(process.env.DB_PORT) || 1433,
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

let poolPromise;

/** Devuelve un pool de conexiones compartido a la base StreamFlix. */
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool({ ...baseConfig, database: process.env.DB_NAME || 'StreamFlix' })
      .connect()
      .catch((err) => { poolPromise = null; throw err; });
  }
  return poolPromise;
}

module.exports = { sql, getPool, baseConfig };
