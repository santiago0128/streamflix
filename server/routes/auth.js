const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sql, getPool } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.Id, username: user.Username, email: user.Email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'Faltan datos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  try {
    const pool = await getPool();
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.request()
      .input('username', sql.NVarChar, username)
      .input('email', sql.NVarChar, email)
      .input('hash', sql.NVarChar, hash)
      .query(`INSERT INTO dbo.Users (Username, Email, PasswordHash)
              OUTPUT INSERTED.Id, INSERTED.Username, INSERTED.Email
              VALUES (@username, @email, @hash)`);
    const user = result.recordset[0];
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) return res.status(409).json({ error: 'El usuario o email ya existe' });
    console.error(err);
    res.status(500).json({ error: 'Error al registrar' });
  }
});

// POST /api/auth/login   (identifier = email o username)
router.post('/login', async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.NVarChar, identifier)
      .query('SELECT TOP 1 * FROM dbo.Users WHERE Email = @id OR Username = @id');
    const u = result.recordset[0];
    if (!u || !(await bcrypt.compare(password, u.PasswordHash))) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    const user = { Id: u.Id, Username: u.Username, Email: u.Email };
    res.json({ token: signToken(user), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /api/auth/me
router.get('/me', authRequired, (req, res) => {
  res.json({ user: { Id: req.user.id, Username: req.user.username, Email: req.user.email } });
});

module.exports = router;
