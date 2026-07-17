const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { parseFile } = require('music-metadata');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.STORAGE_DIR
  ? path.join(process.env.STORAGE_DIR, 'uploads')
  : path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/mp4', 'audio/aac'];
    cb(null, ok.includes(file.mimetype) || file.originalname.match(/\.(mp3|wav|flac|m4a|aac)$/i));
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = db.prepare('SELECT id FROM artists WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const password_hash = hashPassword(password);
    const info = db.prepare(
      'INSERT INTO artists (name, email, password_hash) VALUES (?, ?, ?)'
    ).run(name, email, password_hash);

    const artist = { id: info.lastInsertRowid, name, email };
    const token = signToken(artist);
    res.status(201).json({ token, artist });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const row = db.prepare('SELECT * FROM artists WHERE email = ?').get(email);
    if (!row || !row.password_hash || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const artist = { id: row.id, name: row.name, email: row.email };
    const token = signToken(artist);
    res.json({ token, artist });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/tracks', requireAuth, upload.single('audio'), async (req, res) => {
  try {
    const { title } = req.body;
    if (!req.file || !title) {
      return res.status(400).json({ error: 'title and audio file are required' });
    }

    let duration = null;
    try {
      const meta = await parseFile(req.file.path);
      duration = meta.format.duration || null;
    } catch (e) {
      console.warn('Could not read metadata:', e.message);
    }

    const info = db.prepare(
      'INSERT INTO tracks (title, artist_id, filename, duration_seconds) VALUES (?, ?, ?, ?)'
    ).run(title, req.artist.id, req.file.filename, duration);

    res.status(201).json({
      id: info.lastInsertRowid,
      title,
      artist: req.artist.name,
      duration_seconds: duration,
      stream_url: `/api/stream/${info.lastInsertRowid}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/tracks', (req, res) => {
  const rows = db.prepare(`
    SELECT tracks.id, tracks.title, artists.name AS artist, tracks.duration_seconds
    FROM tracks JOIN artists ON tracks.artist_id = artists.id
    ORDER BY tracks.uploaded_at DESC
  `).all();
  res.json(rows);
});

app.get('/api/stream/:id', (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });

  const filePath = path.join(UPLOAD_DIR, track.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const contentType = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac'
  }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.listen(PORT, () => {
  console.log(`Music platform starter running at http://localhost:${PORT}`);
});
