'use strict';
// POST /api/imagenes/subir      (multipart, campo "imagen")  → { url, sha256 }
// POST /api/imagenes/desde-url  { url }                       → el servidor descarga y guarda
const express = require('express');
const multer = require('multer');
const { guardarBuffer, descargarDesdeUrl, MAX_BYTES } = require('../services/imagenes');
const { HttpError, ah } = require('../utils/http');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

router.post('/subir', requireAuth, (req, res, next) => {
  upload.single('imagen')(req, res, err => {
    if (err) return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      err.code === 'LIMIT_FILE_SIZE' ? 'La imagen es demasiado grande' : 'No se pudo leer el archivo'));
    next();
  });
}, ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Selecciona una imagen');
  res.status(201).json(await guardarBuffer(req.file.buffer));
}));

router.post('/desde-url', requireAuth, ah(async (req, res) => {
  if (!req.body || !req.body.url) throw new HttpError(400, 'Pega el link de la imagen');
  res.status(201).json(await descargarDesdeUrl(req.body.url));
}));

module.exports = router;
