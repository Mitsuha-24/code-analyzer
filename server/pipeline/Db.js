'use strict';
const path = require('path');
const { MongoClient } = require('mongodb');

// All settings come from environment variables so nothing is hard-coded.
const config = {
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
  dbName: process.env.MONGO_DB || 'codetrace',
  // server.js writes its raw .jsonl files to <folder of server.js>/lab_session_data.
  // Defaults assume this pipeline/ folder sits next to server.js. Never deleted by this pipeline.
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'lab_session_data')),
  // Where this pipeline stores snapshot file contents (one file per unique content; the DB keeps a reference)
  snapshotDir: path.resolve(process.env.SNAPSHOT_DIR || path.join(__dirname, '..', 'snapshot_store')),
  // Shared secret for the /admin endpoints. Empty = admin endpoints disabled.
  adminToken: process.env.ADMIN_TOKEN || ''
};

let client;
let db;
let initPromise; // shared, so overlapping callers never open two connections

async function initDb() {
  if (db) return db;
  if (!initPromise) {
    initPromise = (async () => {
      client = new MongoClient(config.mongoUri);
      await client.connect();
      db = client.db(config.dbName);
      await ensureIndexes(db);
      return db;
    })().catch((e) => { initPromise = undefined; client = undefined; db = undefined; throw e; });
  }
  return initPromise;
}

function getDb() {
  if (!db) throw new Error('initDb() has not been called yet');
  return db;
}

// Used by the ingest code: returns the live handle, or connects on demand.
// If this ever prints the warning, the handle was lost (and which db.js instance it was).
async function ensureDb() {
  if (db) return db;
  console.warn(`[pipeline] database handle missing, reconnecting (db.js: ${__filename})`);
  return initDb();
}

async function closeDb() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
  initPromise = undefined;
}

// createIndex is idempotent, so this is safe to run on every start.
async function ensureIndexes(d) {
  // Unique only when the field is a string, so instructors (no studentKey) and
  // auto-created students (no email) do not collide.
  await d.collection('users').createIndex(
    { studentKey: 1 },
    { unique: true, partialFilterExpression: { studentKey: { $type: 'string' } } }
  );
  await d.collection('users').createIndex(
    { email: 1 },
    { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
  );
  await d.collection('sessions').createIndex({ studentKey: 1 });
  await d.collection('sessions').createIndex({ assignmentId: 1 });
  await d.collection('sessions').createIndex({ split: 1, 'label.label': 1 });
  await d.collection('telemetry_windows').createIndex({ sessionId: 1, windowStart: 1 });
  await d.collection('behaviour_events').createIndex({ sessionId: 1, ts: 1 });
  await d.collection('behaviour_events').createIndex({ eventType: 1 });
  await d.collection('code_snapshots').createIndex({ sessionId: 1, takenAt: 1 });
  await d.collection('ingest_log').createIndex({ kind: 1, path: 1 });
}

module.exports = { config, initDb, getDb, ensureDb, closeDb };