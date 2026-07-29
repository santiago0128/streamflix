require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sql = require('mssql');

const dbName = process.env.DB_NAME || 'StreamFlix';
const baseConfig = {
  server: process.env.DB_SERVER || 'localhost',
  port: Number(process.env.DB_PORT) || 1433,
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true }
};

async function run() {
  // 1) Conectar a master y crear la base si no existe
  let pool = await new sql.ConnectionPool({ ...baseConfig, database: 'master' }).connect();
  console.log('→ Conectado a SQL Server (master)');
  await pool.request().batch(`IF DB_ID('${dbName}') IS NULL CREATE DATABASE [${dbName}];`);
  console.log(`→ Base '${dbName}' lista`);
  await pool.close();

  // 2) Conectar a la base y aplicar esquema + seed
  pool = await new sql.ConnectionPool({ ...baseConfig, database: dbName }).connect();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
  await pool.request().batch(schema);
  console.log('→ Esquema aplicado');
  await pool.request().batch(seed);
  console.log('→ Datos de ejemplo cargados');
  await pool.close();
  console.log('✅ Base de datos inicializada correctamente');
}

run().catch((err) => {
  console.error('❌ Error inicializando la base:', err.message);
  process.exit(1);
});
