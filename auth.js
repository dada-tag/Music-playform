const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(check));
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signToken(payload, expiresInSeconds = 60 * 60 * 24 * 30) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const encHeader = base64url(JSON.stringify(header));
  const encBody = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encHeader}.${encBody}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encHeader}.${encBody}.${signature}`;
}

function verifyToken(token) {
  const [encHeader, encBody, signature] = token.split('.');
  if (!encHeader || !encBody || !signature) return null;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encHeader}.${encBody}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (signature !== expected) return null;
  const payload = JSON.parse(Buffer.from(encBody, 'base64').toString('utf8'));
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired session' });
  req.artist = { id: payload.id, name: payload.name };
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, requireAuth };
