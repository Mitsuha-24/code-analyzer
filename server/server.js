// collector-server.js
// Zero-dependency Node server for lab-session data collection.
// Run with: node server.js
// Then set each student's VS Code setting `telemetryLogger.serverUrl`
// to  http://<YOUR_LAPTOP_LAN_IP>:4000/ingest
//
// Find your LAN IP with `ipconfig` (Windows) or `ifconfig` / `ip a` (Mac/Linux) —
// look for the 192.168.x.x or 10.x.x.x address, NOT 127.0.0.1.
//
// This server now receives two kinds of payloads on the same /ingest
// endpoint, distinguished by `payloadType`:
//   - behavioral flush summaries   (no payloadType field — the original shape)
//   - code snapshots                (payloadType === 'code_snapshot')
// Each is routed to its own storage path so the Source Code Analysis stage
// of the pipeline has somewhere to actually read files from, separate from
// the behavioral data path.

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- MongoDB pipeline (optional: the collector keeps working if Mongo is down) ---
const { initDb } = require('./pipeline/Db');
const { scheduleIngest, startSweeper, adminHandler } = require('./pipeline/hooks');

const PORT = 4000;

const OUT_DIR = path.join(__dirname, 'lab_session_data');
const COMBINED_LOG = path.join(OUT_DIR, 'all_students.jsonl');

const SNAPSHOT_DIR = path.join(OUT_DIR, 'code_snapshots');
const COMBINED_SNAPSHOT_LOG = path.join(SNAPSHOT_DIR, 'all_snapshots.jsonl');

// Code snapshots carry full file content, so the payload-size guard needs
// more headroom than a behavioral summary does. 1MB was fine for stats-only
// payloads; source files can reasonably exceed that.
const MAX_PAYLOAD_BYTES = 5_000_000;

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function sanitizeId(value) {
    return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Strips any directory components from a client-supplied filename and keeps
// only safe characters, so it can't be used to write outside SNAPSHOT_DIR
// (e.g. via "../../something") and so odd characters don't break the
// filesystem.
function sanitizeFileName(value) {
    const base = path.basename(String(value || 'unknown_file'));
    return base.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

ensureDir(OUT_DIR);

function appendLine(filePath, line) {
    fs.appendFile(filePath, line + '\n', (err) => {
        if (err) console.error(`[write error] ${filePath}:`, err.message);
    });
}

// ----------------------------------------------------------------------------
// Behavioral flush summaries (existing path, unchanged)
// ----------------------------------------------------------------------------

function handleBehaviorSummary(payload, receivedAt) {
    const id = sanitizeId(payload.studentId);
    const line = JSON.stringify({ receivedAt, ...payload });

    appendLine(COMBINED_LOG, line);
    appendLine(path.join(OUT_DIR, `${id}.jsonl`), line);

    // End of session: the plugin sends a final window with one of these reasons.
    // Ingestion runs later (debounced), never inside this request.
    if (payload.reason === 'logging_stopped' || payload.reason === 'deactivate') {
        scheduleIngest(payload.studentId);
    }

    console.log(`[ingest:behavior] ${id} @ ${receivedAt}`);
}

// ----------------------------------------------------------------------------
// Code snapshots (new path)
// ----------------------------------------------------------------------------
//
// Two things get written per snapshot:
//   1. A JSONL log entry (metadata + content), same append-only pattern as
//      the behavioral logs, per student and combined.
//   2. The actual file content materialized as a real source file on disk,
//      one per (student, session, file), overwritten on each new snapshot
//      for that file. This is what lets FR-4.1 (AST parsing) and FR-4.2
//      (static metrics) point a real parser/linter at a real file path
//      instead of extracting code out of a JSON blob first.

function handleCodeSnapshot(payload, receivedAt) {
    const id = sanitizeId(payload.studentId);
    const sessionId = sanitizeId(payload.sessionId);
    const fileName = sanitizeFileName(payload.file);

    const studentSnapshotDir = path.join(SNAPSHOT_DIR, id);
    const materializedDir = path.join(studentSnapshotDir, 'files');

    ensureDir(studentSnapshotDir);
    ensureDir(materializedDir);

    // Log entry keeps content too, so the full history/audit trail is
    // preserved even though the materialized file below only keeps the
    // latest state per (session, file).
    const logLine = JSON.stringify({ receivedAt, ...payload });

    appendLine(COMBINED_SNAPSHOT_LOG, logLine);
    appendLine(
        path.join(studentSnapshotDir, `${id}_snapshots.jsonl`),
        logLine
    );

    const materializedPath = path.join(
        materializedDir,
        `${sessionId}__${fileName}`
    );

    fs.writeFile(materializedPath, payload.content || '', (err) => {
        if (err) {
            console.error(
                `[write error] ${materializedPath}:`,
                err.message
            );
        }
    });

    console.log(
        `[ingest:snapshot] ${id} (${payload.trigger || 'unknown trigger'}) ${fileName} @ ${receivedAt}`
    );
}

// ----------------------------------------------------------------------------
// Server
// ----------------------------------------------------------------------------

const server = http.createServer((req, res) => {
    if (adminHandler(req, res)) return; // POST /admin/ingest-all (needs x-admin-token)

    if (req.method !== 'POST' || req.url !== '/ingest') {
        res.writeHead(404).end();
        return;
    }

    let body = '';
    let tooLarge = false;

    req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_PAYLOAD_BYTES) {
            tooLarge = true;
            req.destroy();
        }
    });

    req.on('end', () => {
        if (tooLarge) {
            console.error('[ingest] payload exceeded size guard, dropped');
            return;
        }

        try {
            const payload = JSON.parse(body);
            const receivedAt = new Date().toISOString();

            if (payload.payloadType === 'code_snapshot') {
                handleCodeSnapshot(payload, receivedAt);
            } else {
                handleBehaviorSummary(payload, receivedAt);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        } catch (err) {
            console.error('[parse error]', err.message);
            res.writeHead(400).end('{"ok":false}');
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    initDb()
        .then(() => {
            startSweeper();
            console.log('[pipeline] MongoDB connected, ingestion enabled');
        })
        .catch((e) => console.error('[pipeline] MongoDB unavailable, raw .jsonl is still saved:', e.message));

    console.log(`Collector listening on http://0.0.0.0:${PORT}/ingest`);
    console.log(`Behavior data going to: ${OUT_DIR}`);
    console.log(`Code snapshots going to: ${SNAPSHOT_DIR}`);
    console.log(`Give students this URL (with YOUR machine's LAN IP): http://<YOUR_IP>:${PORT}/ingest`);
});