const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { parseFile } = require('music-metadata');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.STORAGE_DIR ? path.join(process.env.STORAGE_DIR, 'uploads') : path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Upload handling ----
// This is Phase 1: raw files served as-is. In Phase 2 you'd swap this
// step for an FFmpeg transcode into HLS segments (see server-hls-note.md).
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
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB cap for the starter
});

// POST /api/tracks — upload a track with title + artist name
app.post('/api/tracks', upload.single('audio'), async (req, res) => {
  try {
    const { title, artist } = req.body;
    if (!req.file || !title || !artist) {
      return res.status(400).json({ error: 'title, artist, and audio file are required' });
    }

    // Get or create artist
    let artistRow = db.prepare('SELECT * FROM artists WHERE name = ?').get(artist);
    if (!artistRow) {
      const info = db.prepare('INSERT INTO artists (name) VALUES (?)').run(artist);
      artistRow = { id: info.lastInsertRowid, name: artist };
    }

    // Pull duration from the audio file itself
    let duration = null;
    try {
      const meta = await parseFile(req.file.path);
      duration = meta.format.duration || null;
    } catch (e) {
      console.warn('Could not read metadata:', e.message);
    }

    const info = db.prepare(
      'INSERT INTO tracks (title, artist_id, filename, duration_seconds) VALUES (?, ?, ?, ?)'
    ).run(title, artistRow.id, req.file.filename, duration);

    res.status(201).json({
      id: info.lastInsertRowid,
      title,
      artist,
      duration_seconds: duration,
      stream_url: `/api/stream/${info.lastInsertRowid}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET /api/tracks — list catalog
app.get('/api/tracks', (req, res) => {
  const rows = db.prepare(`
    SELECT tracks.id, tracks.title, artists.name AS artist, tracks.duration_seconds
    FROM tracks JOIN artists ON tracks.artist_id = artists.id
    ORDER BY tracks.uploaded_at DESC
  `).all();
  res.json(rows);
});

// GET /api/stream/:id — stream audio with HTTP range support
// Range support is what lets the browser seek and lets mobile players
// buffer efficiently — required for any real playback experience.
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
