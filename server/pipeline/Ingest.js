'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ensureDb, config } = require('./Db');
const T = require('./Transform');

const CLEAN_END = new Set(['logging_stopped', 'deactivate']); // flush reasons the plugin uses when a session ends
const running = new Set(); // never ingest the same file twice at the same time

async function flush(coll, ops) {
  for (let i = 0; i < ops.length; i += 1000) {
    await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  }
  ops.length = 0;
}

function writeSnapshotContent(contentRef, content) {
  const full = path.join(config.snapshotDir, contentRef);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  try {
    fs.writeFileSync(full, content, { flag: 'wx' }); // same content twice => stored once
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

// Every student in the telemetry gets a users document, even if they are not
// on the roster yet (source:'auto'), so ingestion never fails on an unknown ID.
async function ensureStudentUser(db, studentId) {
  const key = T.norm(studentId);
  const run = () => db.collection('users').findOneAndUpdate(
    { studentKey: key },
    { $setOnInsert: { name: null, email: null, role: 'student', passwordHash: null, studentId, studentKey: key, source: 'auto', createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  );
  let user;
  try {
    user = await run();
  } catch (e) {
    if (e.code !== 11000) throw e; // two ingests created the same student at the same instant: the second attempt just reads it
    user = await run();
  }
  return user._id;
}

// Session facts that depend on all of its windows are recomputed from the DB,
// so it does not matter if a session was ingested in one go or in pieces.
async function upsertSession(db, sessionId, m) {
  const userId = await ensureStudentUser(db, m.studentId);
  const [agg] = await db.collection('telemetry_windows').aggregate([
    { $match: { sessionId } },
    { $sort: { windowEnd: 1 } },
    { $group: {
      _id: null,
      windowCount: { $sum: 1 },
      startedAt: { $first: '$windowStart' },
      endedAt: { $last: '$windowEnd' },
      endReason: { $last: '$reason' },
      notableEventCount: { $sum: '$notableEventCount' }
    } }
  ]).toArray();
  const snapshotCount = await db.collection('code_snapshots').countDocuments({ sessionId });

  const set = {
    studentId: m.studentId,
    studentKey: T.norm(m.studentId),
    userId,
    taskId: m.taskId,
    assignmentId: m.taskId && m.taskId !== 'unknown' ? m.taskId : null, // plugin taskId = assignmentId
    schemaVersion: m.schemaVersion,
    machineId: m.machineId,
    projectId: m.projectId,
    snapshotCount,
    ingestedAt: new Date()
  };
  if (agg) {
    Object.assign(set, {
      startedAt: agg.startedAt,
      endedAt: agg.endedAt,
      endReason: agg.endReason,
      endedCleanly: CLEAN_END.has(agg.endReason), // false = laptop died / window closed without a stop
      windowCount: agg.windowCount,
      notableEventCount: agg.notableEventCount
    });
  }
  await db.collection('sessions').updateOne(
    { _id: sessionId },
    { $set: set, $setOnInsert: { createdAt: new Date(), label: null, split: null } }, // label/split are never overwritten by ingest
    { upsert: true }
  );
}

async function doIngest(file, db) {
  const st = fs.statSync(file);
  const log = db.collection('ingest_log');
  if (await log.findOne({ kind: 'file', path: file, size: st.size, mtimeMs: st.mtimeMs, ok: true })) {
    return { file, skipped: 'unchanged since last ingest' };
  }

  const wOps = [], eOps = [], sOps = [], rejects = [];
  const sessions = new Map();
  const sum = { file, lines: 0, windows: 0, events: 0, eventsDropped: 0, snapshots: 0, rejected: 0 };
  const reject = (lineNo, reason, raw) => {
    sum.rejected++;
    if (rejects.length < 20) rejects.push({ kind: 'rejected', path: file, lineNo, reason, sample: String(raw).slice(0, 200), at: new Date() });
  };

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    sum.lines++;

    let r;
    try { r = JSON.parse(line); } catch { reject(lineNo, 'bad_json', line); continue; } // e.g. a half-written last line
    const kind = T.classify(r);
    if (!kind) { reject(lineNo, 'unknown_payload', line); continue; }
    const err = T.validate(kind, r);
    if (err) { reject(lineNo, err, line); continue; }

    if (!sessions.has(r.sessionId)) sessions.set(r.sessionId, T.sessionMeta(r));

    if (kind === 'window') {
      const w = T.buildWindow(r);
      wOps.push({ replaceOne: { filter: { _id: w._id }, replacement: w, upsert: true } });
      sum.windows++;
      const { kept, total } = T.buildEvents(r);
      for (const e of kept) eOps.push({ replaceOne: { filter: { _id: e._id }, replacement: e, upsert: true } });
      sum.events += kept.length;
      sum.eventsDropped += total - kept.length;
    } else {
      const { doc, content } = T.buildSnapshot(r);
      writeSnapshotContent(doc.contentRef, content);
      sOps.push({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } });
      sum.snapshots++;
    }

    if (wOps.length >= 1000) await flush(db.collection('telemetry_windows'), wOps);
    if (eOps.length >= 1000) await flush(db.collection('behaviour_events'), eOps);
    if (sOps.length >= 1000) await flush(db.collection('code_snapshots'), sOps);
  }

  if (wOps.length) await flush(db.collection('telemetry_windows'), wOps);
  if (eOps.length) await flush(db.collection('behaviour_events'), eOps);
  if (sOps.length) await flush(db.collection('code_snapshots'), sOps);
  for (const [id, meta] of sessions) await upsertSession(db, id, meta);

  if (rejects.length) await log.insertMany(rejects); // capped at 20 per file so a bad file cannot flood the log
  sum.sessions = [...sessions.keys()];
  await log.insertOne({ kind: 'file', path: file, size: st.size, mtimeMs: st.mtimeMs, ok: true, at: new Date(), ...sum });
  return sum;
}

async function ingestFile(file, db) {
  if (running.has(file)) return { file, skipped: 'already running' };
  running.add(file);
  try {
    db = db || await ensureDb();
    return await doIngest(file, db);
  } catch (e) {
    if (db) await db.collection('ingest_log').insertOne({ kind: 'file', path: file, ok: false, error: e.message, at: new Date() }).catch(() => {});
    throw e; // the original error, never a secondary one
  } finally {
    running.delete(file);
  }
}

module.exports = { ingestFile };