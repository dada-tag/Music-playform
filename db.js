const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.STORAGE_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DB_DIR, 'catalog.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist_id INTEGER REFERENCES artists(id),
    filename TEXT NOT NULL,
    duration_seconds REAL,
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('artists', 'email', 'TEXT');
ensureColumn('artists', 'password_hash', 'TEXT');
ensureColumn('artists', 'created_at', 'TEXT');

const tableDef = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='artists'"
).get();
if (tableDef && /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(tableDef.sql)) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    ALTER TABLE artists RENAME TO artists_old;
    CREATE TABLE artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO artists (id, name, email, password_hash, created_at)
      SELECT id, name, email, password_hash, created_at FROM artists_old;
    DROP TABLE artists_old;
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}

module.exports = db;
