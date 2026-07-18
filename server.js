const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const { parseBuffer } = require("music-metadata");
const { hashPassword, verifyPassword, signToken, requireAuth } = require("./auth");
const storage = require("./storage");
const { transcodeToHLS } = require("./hls");
const { execSync } = require("child_process");
try {
  const v = execSync("ffmpeg -version").toString().split("\n")[0];
  console.log("ffmpeg check:", v);
} catch (e) {
  console.log("ffmpeg check FAILED:", e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

if (storage.USE_R2) {
  console.log("Storage: using Cloudflare R2");
} else {
  console.log("Storage: using local disk (R2 env vars not set)");
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ok = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac", "audio/mp4", "audio/aac"];
    cb(null, ok.includes(file.mimetype) || file.originalname.match(/\.(mp3|wav|flac|m4a|aac)$/i));
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email, and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const existing = db.prepare("SELECT id FROM artists WHERE email = ?").get(email);
    if (existing) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const password_hash = hashPassword(password);
    const info = db.prepare(
      "INSERT INTO artists (name, email, password_hash) VALUES (?, ?, ?)"
    ).run(name, email, password_hash);

    const artist = { id: info.lastInsertRowid, name, email };
    const token = signToken(artist);
    res.status(201).json({ token, artist });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const row = db.prepare("SELECT * FROM artists WHERE email = ?").get(email);
    if (!row || !row.password_hash || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const artist = { id: row.id, name: row.name, email: row.email };
    const token = signToken(artist);
    res.json({ token, artist });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/tracks", requireAuth, upload.single("audio"), async (req, res) => {
  try {
    const { title } = req.body;
    if (!req.file || !title) {
      return res.status(400).json({ error: "title and audio file are required" });
    }

    let duration = null;
    try {
      const meta = await parseBuffer(req.file.buffer, req.file.mimetype);
      duration = meta.format.duration || null;
    } catch (e) {
      console.warn("Could not read metadata:", e.message);
    }

    const unique = Date.now() + "-" + crypto.randomBytes(6).toString("hex");
    const filename = unique + path.extname(req.file.originalname);

    await storage.uploadFile(filename, req.file.buffer, req.file.mimetype);

    let hlsPlaylistKey = null;
    try {
      const hlsFiles = await transcodeToHLS(req.file.buffer, path.extname(req.file.originalname));
      for (const f of hlsFiles) {
        const key = `hls/${unique}/${f.name}`;
        await storage.uploadFile(key, f.buffer, f.contentType);
        if (f.name.endsWith(".m3u8")) hlsPlaylistKey = key;
      }
    } catch (e) {
      console.error("HLS transcoding failed:", e.message);
    }

    const info = db.prepare(
      "INSERT INTO tracks (title, artist_id, filename, duration_seconds, hls_playlist_key) VALUES (?, ?, ?, ?, ?)"
    ).run(title, req.artist.id, filename, duration, hlsPlaylistKey);

    res.status(201).json({
      id: info.lastInsertRowid,
      title,
      artist: req.artist.name,
      duration_seconds: duration,
      stream_url: `/api/stream/${info.lastInsertRowid}`,
      hls_url: hlsPlaylistKey ? `/api/hls/${info.lastInsertRowid}/playlist.m3u8` : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.get("/api/tracks", async (req, res) => {
  const rows = db.prepare(`
    SELECT tracks.id, tracks.title, artists.name AS artist, tracks.duration_seconds
    FROM tracks JOIN artists ON tracks.artist_id = artists.id
    ORDER BY tracks.uploaded_at DESC
  `).all();
  res.json(rows);
});

app.get("/api/stream/:id", async (req, res) => {
  const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(req.params.id);
  if (!track) return res.status(404).json({ error: "Track not found" });

  try {
    const result = await storage.getFileStream(track.filename, req.headers.range);
    const headers = {
      "Content-Type": result.contentType,
      "Content-Length": result.contentLength,
      "Accept-Ranges": "bytes"
    };
    if (result.contentRange) headers["Content-Range"] = result.contentRange;

    res.writeHead(result.statusCode, headers);
    result.stream.pipe(res);
  } catch (err) {
    if (err.code === "ENOENT" || err.name === "NoSuchKey") {
      return res.status(404).json({ error: "File missing from storage" });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to stream file" });
  }
});

app.get("/api/hls/:id/:file", async (req, res) => {
  const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(req.params.id);
  if (!track || !track.hls_playlist_key) {
    return res.status(404).json({ error: "HLS stream not available for this track" });
  }

  const prefix = track.hls_playlist_key.slice(0, track.hls_playlist_key.lastIndexOf("/"));
  const key = `${prefix}/${req.params.file}`;

  try {
    const result = await storage.getFileStream(key, req.headers.range);
    const headers = {
      "Content-Type": result.contentType,
      "Content-Length": result.contentLength,
      "Accept-Ranges": "bytes"
    };
    if (result.contentRange) headers["Content-Range"] = result.contentRange;

    res.writeHead(result.statusCode, headers);
    result.stream.pipe(res);
  } catch (err) {
    if (err.code === "ENOENT" || err.name === "NoSuchKey") {
      return res.status(404).json({ error: "HLS file missing from storage" });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to stream HLS file" });
  }
});

app.listen(PORT, () => {
  console.log(`Music platform starter running at http://localhost:${PORT}`);
});
