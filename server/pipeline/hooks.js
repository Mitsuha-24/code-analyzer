'use strict';
const fs = require('fs');
const path = require('path');
const { config } = require('./db');
const { ingestFile } = require('./ingest');

const MAX_CONCURRENT = 4; // at exam end many students stop at once; never ingest more than this many at a time
const COMBINED = new Set(['all_students.jsonl', 'all_snapshots.jsonl']); // server.js duplicates every line into these
const timers = new Map();
const log = (...a) => console.log('[pipeline]', ...a);

// Same rule as sanitizeId() in server.js, so we compute the exact file names it writes.
const sanitizeId = (v) => String(v || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

// server.js layout:
//   lab_session_data/<id>.jsonl                               behaviour windows, one file per student
//   lab_session_data/code_snapshots/<id>/<id>_snapshots.jsonl snapshots, one file per student
//   plus all_*.jsonl combined copies (skipped) and code_snapshots/<id>/files/ (materialised source, skipped)
function listJsonl(dir = config.dataDir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'files') out.push(...listJsonl(full));
    } else if (entry.name.endsWith('.jsonl') && !COMBINED.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function filesForStudent(studentId) {
  const id = sanitizeId(studentId).toLowerCase();
  const wanted = new Set([`${id}.jsonl`, `code_snapshots/${id}/${id}_snapshots.jsonl`]);
  return listJsonl().filter((f) => wanted.has(path.relative(config.dataDir, f).split(path.sep).join('/').toLowerCase()));
}

let active = 0;
const waiting = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { active--; const next = waiting.shift(); if (next) next(); }
    };
    if (active < MAX_CONCURRENT) run(); else waiting.push(run);
  });
}

async function ingestStudent(studentId) {
  const out = [];
  for (const f of filesForStudent(studentId)) out.push(await ingestFile(f));
  return out;
}

async function ingestAll() {
  const out = [];
  for (const f of listJsonl()) out.push(await ingestFile(f));
  return out;
}

// Trigger 1 (automatic): call from handleBehaviorSummary when reason is 'logging_stopped' or 'deactivate'.
// The delay lets the stop-time snapshots (posted just before that window) reach disk first;
// the debounce turns several quick triggers for one student into one ingest.
function scheduleIngest(studentId, delayMs = 10000) {
  clearTimeout(timers.get(studentId));
  timers.set(studentId, setTimeout(async () => {
    timers.delete(studentId);
    try {
      const res = await limited(() => ingestStudent(studentId));
      log(`ingested ${studentId}:`, JSON.stringify(res.map((r) => r.skipped || { w: r.windows, e: r.events, s: r.snapshots, rej: r.rejected })));
    } catch (e) {
      console.error('[pipeline] ingest failed for', studentId, '-', e.message);
    }
  }, delayMs));
}

// Trigger 3 (safety net): files quiet for idleMs belong to sessions that ended without a stop.
function startSweeper({ everyMs = 10 * 60 * 1000, idleMs = 30 * 60 * 1000 } = {}) {
  const t = setInterval(async () => {
    for (const f of listJsonl()) {
      try {
        if (Date.now() - fs.statSync(f).mtimeMs >= idleMs) await limited(() => ingestFile(f));
      } catch (e) {
        console.error('[pipeline] sweep failed for', f, '-', e.message);
      }
    }
  }, everyMs);
  t.unref();
  return t;
}

// Trigger 2 (manual): POST /admin/ingest-all with header x-admin-token. Plain-http version (server.js has no Express).
// Returns true when it handled the request, so server.js can `return` early.
function adminHandler(req, res) {
  if (!req.url.startsWith('/admin/')) return false;
  if (!config.adminToken || req.headers['x-admin-token'] !== config.adminToken) {
    res.writeHead(403).end();
    return true;
  }
  if (req.method === 'POST' && req.url === '/admin/ingest-all') {
    ingestAll()
      .then((r) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(r)))
      .catch((e) => res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message })));
    return true;
  }
  res.writeHead(404).end();
  return true;
}

module.exports = { scheduleIngest, startSweeper, adminHandler, ingestStudent, ingestAll, listJsonl, filesForStudent };