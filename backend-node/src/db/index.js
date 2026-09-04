const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function restrictDatabaseFilePermissions(dbPath) {
  for (const filePath of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
    } catch (_) {
      // Windows and some packaged filesystems may not support POSIX modes.
    }
  }
}

function getDb(config) {
  if (db) return db;
  const dbPath = config.path;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath, {
    verbose: config.type === 'sqlite' && process.env.DEBUG ? console.log : undefined,
  });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  restrictDatabaseFilePermissions(dbPath);
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
