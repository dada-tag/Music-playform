# Music Platform Starter

A minimal, working audio upload + streaming backend. This is Phase 1 of the
build order: raw file storage + direct playback, no HLS/CDN yet. It's meant
to prove the core loop works before you invest in infrastructure.

## What's included

- `server.js` — Express server with 3 endpoints:
  - `POST /api/tracks` — upload an audio file + title/artist
  - `GET /api/tracks` — list the catalog
  - `GET /api/stream/:id` — stream audio with HTTP range support (seeking works)
- `db.js` — SQLite schema (artists, tracks) via better-sqlite3
- `public/index.html` — a bare-bones web player: upload a file, see it in
  the list, click play

## Setup

Requires Node.js 18+.

```bash
cd music-platform
npm install
npm start
```

Then open **http://localhost:3000** in your browser. Upload an MP3/WAV/FLAC,
give it a title and artist, and it'll appear in the list — click Play to
stream it.

## What this deliberately does NOT do yet

This is Phase 1 only. Missing on purpose, to add as you progress:

- **No HLS/adaptive bitrate** — files are served raw. Phase 2 replaces the
  upload handler with an FFmpeg transcode step that outputs `.m3u8` +
  segments instead of storing the raw file.
- **No CDN** — files are served from local disk. Swap `UPLOAD_DIR` for S3/R2
  and put a CDN in front once you're past prototyping.
- **No auth** — anyone can upload/stream. Add a JWT-based auth service
  before this goes anywhere near production.
- **No signed URLs** — the stream endpoint is open. Add expiring signed
  URLs before you have content worth protecting.
- **No playlists/search/recommendations** — Phase 3 territory.

## Next steps (in order)

1. Get this running locally and upload a few tracks — confirm playback works
2. Add FFmpeg transcoding to HLS (`ffmpeg -i input.mp3 -c:a aac -b:a 128k -hls_time 6 -hls_playlist_type vod output.m3u8`)
3. Move storage to S3/R2 + add a CDN
4. Add auth and a proper `users` table
5. Add playlists and search
