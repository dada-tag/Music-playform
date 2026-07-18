const fs = require('fs');
const path = require('path');

const USE_R2 = Boolean(
  process.env.R2_ENDPOINT &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME
);

const LOCAL_UPLOAD_DIR = process.env.STORAGE_DIR
  ? path.join(process.env.STORAGE_DIR, 'uploads')
  : path.join(__dirname, 'uploads');

if (!USE_R2 && !fs.existsSync(LOCAL_UPLOAD_DIR)) {
  fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
}

let s3Client = null;
if (USE_R2) {
  const { S3Client } = require('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function uploadFile(filename, buffer, contentType) {
  if (USE_R2) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: filename,
      Body: buffer,
      ContentType: contentType,
    }));
  } else {
    const destPath = path.join(LOCAL_UPLOAD_DIR, filename);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
  }
}

async function getFileStream(filename, rangeHeader) {
  if (USE_R2) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: filename,
      Range: rangeHeader || undefined,
    });
    const response = await s3Client.send(command);
    return {
      stream: response.Body,
      contentType: response.ContentType || 'application/octet-stream',
      contentLength: response.ContentLength,
      contentRange: response.ContentRange,
      statusCode: response.ContentRange ? 206 : 200,
    };
  } else {
    const filePath = path.join(LOCAL_UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) {
      const err = new Error('File not found');
      err.code = 'ENOENT';
      throw err;
    }
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const contentType = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
    }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      return {
        stream: fs.createReadStream(filePath, { start, end }),
        contentType,
        contentLength: end - start + 1,
        contentRange: `bytes ${start}-${end}/${fileSize}`,
        statusCode: 206,
      };
    }
    return {
      stream: fs.createReadStream(filePath),
      contentType,
      contentLength: fileSize,
      contentRange: null,
      statusCode: 200,
    };
  }
}

module.exports = { uploadFile, getFileStream, USE_R2 };
