// collector-server.js
// Zero-dependency Node server for lab-session data collection.
// Run with: node server.js
// Then set each student's VS Code setting `telemetryLogger.serverUrl`
// to  http://<YOUR_LAPTOP_LAN_IP>:4000/ingest
//
// Find your LAN IP with `ipconfig` (Windows) or `ifconfig` / `ip a` (Mac/Linux) —
// look for the 192.168.x.x or 10.x.x.x address, NOT 127.0.0.1.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4000;
const OUT_DIR = path.join(__dirname, 'lab_session_data');
const COMBINED_LOG = path.join(OUT_DIR, 'all_students.jsonl');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function appendLine(filePath, line) {
    fs.appendFile(filePath, line + '\n', (err) => {
        if (err) console.error(`[write error] ${filePath}:`, err.message);
    });
}

const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/ingest') {
        res.writeHead(404).end();
        return;
    }

    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(); // basic guard against runaway payloads
    });

    req.on('end', () => {
        try {
            const summary = JSON.parse(body);
            const id = (summary.studentId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
            const receivedAt = new Date().toISOString();
            const line = JSON.stringify({ receivedAt, ...summary });

            // one combined file for the whole lab, plus one file per student for convenience
            appendLine(COMBINED_LOG, line);
            appendLine(path.join(OUT_DIR, `${id}.jsonl`), line);

            console.log(`[ingest] ${id} @ ${receivedAt}`);
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        } catch (err) {
            console.error('[parse error]', err.message);
            res.writeHead(400).end('{"ok":false}');
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Collector listening on http://0.0.0.0:${PORT}/ingest`);
    console.log(`Data going to: ${OUT_DIR}`);
    console.log(`Give students this URL (with YOUR machine's LAN IP): http://<YOUR_IP>:${PORT}/ingest`);
});