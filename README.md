# Telemetry Logger

A VS Code extension that logs aggregated coding-session telemetry for an
AI-generated vs. human-written code detection research project. It feeds a
Transformer + GNN classification model as the data collection layer.

Instead of logging every keystroke, it aggregates activity into a session
summary flushed every 30 seconds (plus immediately on meaningful boundaries
like a debug session ending or a git commit).

## Features

- **Aggregated stats per window**: keystrokes, chars added/deleted, deletions,
  tab switches, file saves, files touched, and average pause time between edits.
- **Paste-source classification**: large insertions are checked against the
  current file, other open files, and the clipboard to estimate whether code
  was copied from the same file, another open file, or an external source.
- **Post-paste edit tracking**: measures how much a pasted block gets reworked
  afterward, and whether a run/debug happens shortly after a paste.
- **Focus-loss tracking**: records blur/focus cycles as a weak signal for the
  user looking away from the editor.
- **Run detection**: covers both native VS Code Tasks/Debug sessions and
  terminal-based runs (e.g. Code Runner, `python foo.py`) where supported.
- **Optional central collection**: each summary can also be POSTed to a
  collector server on the same network, in addition to always being written
  locally as a backup.
- No raw code or keystroke text is captured — only aggregate counts and
  timing (`CAPTURE_TEXT_SNIPPETS` is off by default).

## Requirements

None to run standalone — logs locally out of the box.

To send data to a central collector during a lab session, run the companion
`server.js` script on a machine on the same network, then set the
`telemetryLogger.serverUrl` setting described below.

## Extension Settings

This extension contributes the following setting:

* `telemetryLogger.serverUrl`: URL of a central collector endpoint, e.g.
  `http://192.168.1.20:4000/ingest`. Leave blank to log locally only.

On first activation, the extension also prompts once for a student ID /
roll number, which is stored per machine and attached to every logged summary.

## Known Issues

- Paste-source classification is best-effort: it can't detect content typed
  manually from an external reference (e.g. reading off a phone or a second
  device).
- Terminal-based run detection relies on `onDidStartTerminalShellExecution`,
  available in VS Code 1.93+. On older versions, only native Task/Debug runs
  are captured.

## Release Notes

### 0.0.1

Initial release: aggregated session logging, paste-source classification,
focus-loss tracking, and optional central collection.

---

**For more information:** see the project write-up in `coding_detection_analysis.docx`.