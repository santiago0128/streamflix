const express = require('express');
const { sql, getPool } = require('../db');
const { authRequired } = require('../middleware/auth');
const { avisarSolicitud } = require('../lib/telegram');

const router = express.Router();
router.use(authRequired); // pedir contenido exige sesión: así se sabe de quién viene

const TIPOS = ['anime', 'series', 'movie'];

// Tope de solicitudes abiertas por persona. No es una regla de negocio, es un
// freno: sin él, una sola cuenta puede llenar la cola en un minuto.
const MAX_PENDIENTES = 5;

const limpiar = (valor, max) => String(valor == null ? '' : valor).trim().slice(0, max);

// GET /api/requests -> lo que ha pedido quien consulta
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.Int, req.user.id)
      .query(`SELECT Id, Title, ContentType, Notes, Status, ResultNote, CreatedAt
                FROM dbo.ContentRequests
               WHERE UserId = @userId
               ORDER BY CreatedAt DESC`);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las solicitudes' });
  }
});

// POST /api/requests  { title, contentType, notes }
router.post('/', async (req, res) => {
  const title = limpiar(req.body && req.body.title, 200);
  const contentType = limpiar(req.body && req.body.contentType, 20).toLowerCase();
  const notes = limpiar(req.body && req.body.notes, 500);

  if (title.length < 2) return res.status(400).json({ error: 'Escribe el título de lo que quieres' });
  if (!TIPOS.includes(contentType)) return res.status(400).json({ error: 'Tipo de contenido inválido' });

  try {
    const pool = await getPool();

    const abiertas = await pool.request()
      .input('userId', sql.Int, req.user.id)
      .query(`SELECT COUNT(*) AS n FROM dbo.ContentRequests
               WHERE UserId = @userId AND Status = 'pendiente'`);
    if (abiertas.recordset[0].n >= MAX_PENDIENTES) {
      return res.status(429).json({
        error: `Ya tienes ${MAX_PENDIENTES} solicitudes pendientes. Espera a que se atienda alguna.`
      });
    }

    // El índice único filtrado ya impide el duplicado en la base; esto es para
    // poder responder algo que se entienda en vez de un error de SQL.
    const repetida = await pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('title', sql.NVarChar(200), title)
      .query(`SELECT TOP 1 Id FROM dbo.ContentRequests
               WHERE UserId = @userId AND Title = @title AND Status = 'pendiente'`);
    if (repetida.recordset.length) {
      return res.status(409).json({ error: 'Ya pediste ese título y sigue pendiente' });
    }

    const inserted = await pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('title', sql.NVarChar(200), title)
      .input('contentType', sql.NVarChar(20), contentType)
      .input('notes', sql.NVarChar(500), notes || null)
      .query(`INSERT INTO dbo.ContentRequests (UserId, Title, ContentType, Notes)
              OUTPUT INSERTED.Id, INSERTED.Title, INSERTED.ContentType,
                     INSERTED.Notes, INSERTED.Status, INSERTED.CreatedAt
              VALUES (@userId, @title, @contentType, @notes)`);

    const solicitud = inserted.recordset[0];

    // El aviso va después de responder y sin await: ya está guardada, así que
    // que Telegram tarde o falle no puede dejar al usuario esperando ni
    // convertir una solicitud buena en un error.
    res.status(201).json(solicitud);
    avisarSolicitud({
      id: solicitud.Id,
      title: solicitud.Title,
      contentType: solicitud.ContentType,
      notes: solicitud.Notes,
      usuario: req.user.username || req.user.email || `usuario ${req.user.id}`
    }).then((r) => {
      if (!r.enviado && r.motivo !== 'sin configurar') {
        console.warn('Aviso de solicitud no entregado:', r.motivo || r.estado);
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la solicitud' });
  }
});

// DELETE /api/requests/:id -> retirar una propia que siga pendiente
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const pool = await getPool();
    // El UserId en el WHERE es lo que impide borrar la de otro conociendo su id.
    const result = await pool.request()
      .input('id', sql.Int, id)
      .input('userId', sql.Int, req.user.id)
      .query(`DELETE FROM dbo.ContentRequests
               WHERE Id = @id AND UserId = @userId AND Status = 'pendiente'`);
    if (!result.rowsAffected[0]) {
      return res.status(404).json({ error: 'No existe, no es tuya o ya se atendió' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al retirar la solicitud' });
  }
});

module.exports = router;
