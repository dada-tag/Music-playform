const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function transcodeToHLS(buffer, sourceExt) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hls-"));
  const inputPath = path.join(workDir, `input${sourceExt}`);
  fs.writeFileSync(inputPath, buffer);

  const playlistPath = path.join(workDir, "playlist.m3u8");
  const segmentPattern = path.join(workDir, "segment%03d.ts");

  const args = [
    "-y",
    "-i", inputPath,
    "-vn",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-f", "hls",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", segmentPattern,
    playlistPath,
  ];

  await runFfmpeg(args);

  const files = fs.readdirSync(workDir).filter((f) => f !== path.basename(inputPath));
  const results = files.map((f) => ({
    name: f,
    buffer: fs.readFileSync(path.join(workDir, f)),
    contentType: f.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
  }));

  fs.rmSync(workDir, { recursive: true, force: true });

  return results;
}

module.exports = { transcodeToHLS };
