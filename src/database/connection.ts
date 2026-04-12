// Uses Node.js built-in SQLite (node:sqlite), available in Node.js v22.5+
// No native compilation required.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
import { DB_PATH } from '../config';

let _db: InstanceType<typeof DatabaseSync> | null = null;

export function getDb(): InstanceType<typeof DatabaseSync> {
  if (_db) return _db;

  _db = new DatabaseSync(DB_PATH);

  // Security & performance pragmas (node:sqlite uses exec for pragmas)
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _db.exec('PRAGMA synchronous = NORMAL');
  _db.exec('PRAGMA temp_store = MEMORY');
  _db.exec('PRAGMA cache_size = -32000');

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
