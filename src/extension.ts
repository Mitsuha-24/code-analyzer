import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

// ─────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────
const CAPTURE_TEXT_SNIPPETS = false;
const FLUSH_INTERVAL_MS = 30_000; // write a summary every 30s instead of per-event

const PASTE_CHAR_THRESHOLD = 15;        // insertions bigger than this get classified
const EDIT_RATIO_WINDOW_MS = 3 * 60_000; // how long we keep watching a file after a paste
const RUN_AFTER_PASTE_WINDOW_MS = 2 * 60_000; // "did they run it soon after pasting?"
const FOCUS_LOSS_MIN_MS = 3_000;        // ignore blur/focus blips shorter than this
const SERVER_POST_TIMEOUT_MS = 4_000;   // don't let a slow/dead server hang the extension

let outputChannel: vscode.OutputChannel;
let logFilePath: string;
let flushTimer: NodeJS.Timeout;
let studentId: string = 'unknown';
let loggingActive: boolean = true; // toggled via "Telemetry Logger: Stop/Resume Logging" commands

const lastEditTimestamp = new Map<string, number>();

let writeQueue: Promise<void> = Promise.resolve();
function enqueueWrite(line: string) {
    writeQueue = writeQueue
        .then(() => fs.promises.appendFile(logFilePath, line + '\n'))
        .catch((err) => outputChannel.appendLine(`[write error] ${err}`));
}

// ── Paste-source classification ──
// Scenario 3 vs 4: "copied from same file & tweaked" vs "copied from elsewhere & tweaked"
// vs plain AI/external paste. We can't know for certain, but we can narrow it down.
type PasteSource = 'same_file' | 'other_open_file' | 'external_clipboard' | 'unknown';

interface PasteEvent {
    source: PasteSource;
    length: number;
}

// Tracks "what happened after a paste landed in this file" so we can compute
// an edit-ratio and a run-after-paste signal without doing precise range math
// (ranges shift as the document changes, so we use a time-windowed approximation).
interface PostPasteWatch {
    fileKey: string;
    timestamp: number;
    pasteLength: number;
    charsChangedSince: number;
}
const activePasteWatches = new Map<string, PostPasteWatch>(); // keyed by fileKey
let lastPasteTimestamp = 0;

// Focus-loss tracking — a weak proxy for "user looked away" (Scenario 1: phone-peeking).
// We can't see the phone, but unusually long pauses combined with focus loss (e.g. tabbing
// to a browser) is at least a signal worth feeding the model, even if imperfect.
let windowFocused = true;
let focusLostAt = 0;

// ── Aggregate state — resets after every flush ──
interface SessionStats {
    windowStart: string;
    keystrokes: number;
    charsAdded: number;
    charsDeleted: number;
    pastesOrGenerated: number;
    deletions: number;
    tabSwitches: number;
    fileSaves: number;
    debugSessionsStarted: number;
    debugSessionsEnded: number;
    tasksRun: number;
    gitCommits: number;
    filesTouched: Set<string>;
    totalPauseMs: number;
    pauseSamples: number;

    // ── new: paste-source breakdown (Scenarios 3 & 4) ──
    pasteEvents: PasteEvent[];
    editRatiosPostPaste: number[]; // how much of a pasted block got reworked afterward
    runsShortlyAfterPaste: number; // task/debug run within RUN_AFTER_PASTE_WINDOW_MS of a paste

    // ── new: focus-loss proxy (Scenario 1) ──
    focusLossCount: number;
    totalFocusLossMs: number;
}

function freshStats(): SessionStats {
    return {
        windowStart: new Date().toISOString(),
        keystrokes: 0,
        charsAdded: 0,
        charsDeleted: 0,
        pastesOrGenerated: 0,
        deletions: 0,
        tabSwitches: 0,
        fileSaves: 0,
        debugSessionsStarted: 0,
        debugSessionsEnded: 0,
        tasksRun: 0,
        gitCommits: 0,
        filesTouched: new Set(),
        totalPauseMs: 0,
        pauseSamples: 0,
        pasteEvents: [],
        editRatiosPostPaste: [],
        runsShortlyAfterPaste: 0,
        focusLossCount: 0,
        totalFocusLossMs: 0,
    };
}

let stats = freshStats();

// ── Send each flushed summary to a central collector over the lab LAN ──
// Local file write always still happens as a backup — this is best-effort on top of it.
function getServerUrl(): string | undefined {
    const configured = vscode.workspace.getConfiguration('telemetryLogger').get<string>('serverUrl');
    return configured && configured.trim().length > 0 ? configured.trim() : undefined;
}

function postToServer(jsonPayload: string) {
    const url = getServerUrl();
    if (!url) return; // no server configured — local file only

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        outputChannel.appendLine(`[server] invalid serverUrl setting: ${url}`);
        return;
    }

    const req = http.request(
        {
            hostname: parsed.hostname,
            port: parsed.port || 80,
            path: parsed.pathname || '/ingest',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: SERVER_POST_TIMEOUT_MS,
        },
        (res) => {
            res.resume(); // drain response, we don't need the body
            if (res.statusCode && res.statusCode >= 400) {
                outputChannel.appendLine(`[server] ingest rejected: HTTP ${res.statusCode}`);
            }
        }
    );

    req.on('timeout', () => req.destroy());
    req.on('error', (err) => {
        // lab wifi drops, server not running yet, etc. — don't crash, local file still has it
        outputChannel.appendLine(`[server] post failed (kept locally): ${err.message}`);
    });

    req.write(jsonPayload);
    req.end();
}

function average(nums: number[]): number {
    if (nums.length === 0) return 0;
    return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

function flushStats(reason: string) {
    // settle any post-paste watches that have expired before we summarize
    settleExpiredPasteWatches();

    if (
        stats.keystrokes === 0 &&
        stats.tabSwitches === 0 &&
        stats.fileSaves === 0 &&
        stats.debugSessionsStarted === 0 &&
        stats.tasksRun === 0 &&
        stats.gitCommits === 0 &&
        stats.pasteEvents.length === 0 &&
        stats.focusLossCount === 0
    ) {
        return; // nothing happened this window — skip empty summaries
    }

    const pasteBySource = { same_file: 0, other_open_file: 0, external_clipboard: 0, unknown: 0 };
    stats.pasteEvents.forEach((p) => pasteBySource[p.source]++);

    const summary = {
        studentId,
        machineId: vscode.env.machineId,
        windowStart: stats.windowStart,
        windowEnd: new Date().toISOString(),
        reason,
        keystrokes: stats.keystrokes,
        charsAdded: stats.charsAdded,
        charsDeleted: stats.charsDeleted,
        pastesOrGenerated: stats.pastesOrGenerated,
        deletions: stats.deletions,
        tabSwitches: stats.tabSwitches,
        fileSaves: stats.fileSaves,
        debugSessionsStarted: stats.debugSessionsStarted,
        debugSessionsEnded: stats.debugSessionsEnded,
        tasksRun: stats.tasksRun,
        gitCommits: stats.gitCommits,
        filesTouched: Array.from(stats.filesTouched),
        avgPauseMs:
            stats.pauseSamples > 0 ? Math.round(stats.totalPauseMs / stats.pauseSamples) : 0,

        // paste-source breakdown — helps separate self-copy (3/4) from external/AI paste
        pasteSourceBreakdown: pasteBySource,
        avgEditRatioPostPaste: average(stats.editRatiosPostPaste), // ~0 = left as-is, higher = reworked
        runsShortlyAfterPaste: stats.runsShortlyAfterPaste,

        // focus-loss proxy — weak signal for "looked away" (phone, another window, etc.)
        focusLossCount: stats.focusLossCount,
        avgFocusLossMs:
            stats.focusLossCount > 0 ? Math.round(stats.totalFocusLossMs / stats.focusLossCount) : 0,
    };

    const jsonString = JSON.stringify(summary);
    outputChannel.appendLine(jsonString);
    enqueueWrite(jsonString);
    postToServer(jsonString);

    stats = freshStats();
}

// ── Classify where a large insertion likely came from ──
// Best-effort only: VS Code doesn't expose "this was a paste from X", so we infer it
// by checking whether the inserted text already exists elsewhere (same file / other
// open file) or matches the current clipboard (external source, origin unknown).
async function classifyPasteSource(
    document: vscode.TextDocument,
    insertedText: string,
    insertOffset: number
): Promise<PasteSource> {
    const needle = insertedText.trim();
    if (needle.length < PASTE_CHAR_THRESHOLD) return 'unknown';

    // 1. Does this text already exist elsewhere in the SAME file (outside where it landed)?
    const fullText = document.getText();
    const before = fullText.slice(0, insertOffset);
    const after = fullText.slice(insertOffset + insertedText.length);
    if (before.includes(needle) || after.includes(needle)) {
        return 'same_file';
    }

    // 2. Does it exist in another currently-open document?
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.toString() === document.uri.toString()) continue;
        if (doc.getText().includes(needle)) {
            return 'other_open_file';
        }
    }

    // 3. Does it match the current clipboard? (confirms a paste happened; origin unknown
    //    beyond that — could be AI-tool output, browser, another project, etc.)
    try {
        const clip = (await vscode.env.clipboard.readText()).trim();
        if (clip.length > 0 && (clip === needle || clip.includes(needle) || needle.includes(clip))) {
            return 'external_clipboard';
        }
    } catch {
        // clipboard read can fail (permissions, empty, etc.) — fall through
    }

    return 'unknown';
}

// ── Track what happens to a pasted block afterward (edit ratio + run-after-paste) ──
function startPostPasteWatch(fileKey: string, pasteLength: number, timestamp: number) {
    activePasteWatches.set(fileKey, {
        fileKey,
        timestamp,
        pasteLength,
        charsChangedSince: 0,
    });
    lastPasteTimestamp = timestamp;
}

function recordPostPasteEdit(fileKey: string, charsChanged: number) {
    const watch = activePasteWatches.get(fileKey);
    if (!watch) return;
    if (Date.now() - watch.timestamp > EDIT_RATIO_WINDOW_MS) {
        settleWatch(fileKey);
        return;
    }
    watch.charsChangedSince += charsChanged;
}

function settleWatch(fileKey: string) {
    const watch = activePasteWatches.get(fileKey);
    if (!watch) return;
    const ratio = watch.pasteLength > 0 ? watch.charsChangedSince / watch.pasteLength : 0;
    stats.editRatiosPostPaste.push(Math.round(ratio * 100) / 100);
    activePasteWatches.delete(fileKey);
}

function settleExpiredPasteWatches() {
    const now = Date.now();
    for (const [fileKey, watch] of activePasteWatches) {
        if (now - watch.timestamp > EDIT_RATIO_WINDOW_MS) {
            settleWatch(fileKey);
        }
    }
}

function noteRunEvent() {
    if (lastPasteTimestamp === 0) return;
    if (Date.now() - lastPasteTimestamp <= RUN_AFTER_PASTE_WINDOW_MS) {
        stats.runsShortlyAfterPaste += 1;
    }
}

async function resolveStudentId(context: vscode.ExtensionContext): Promise<string> {
    const stored = context.globalState.get<string>('telemetryLogger.studentId');
    if (stored && stored.trim().length > 0) return stored;

    const entered = await vscode.window.showInputBox({
        title: 'Lab Telemetry Logger',
        prompt: 'Enter your roll number / student ID (asked once per machine)',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length === 0 ? 'Required' : null),
    });

    const id = entered && entered.trim().length > 0 ? entered.trim() : `anon-${Date.now()}`;
    await context.globalState.update('telemetryLogger.studentId', id);
    return id;
}

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Telemetry Logger');
    outputChannel.appendLine('--- Telemetry Logger Activated ---');

    studentId = await resolveStudentId(context);
    outputChannel.appendLine(`Logging as: ${studentId}`);

    const storagePath = context.globalStorageUri.fsPath;
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }
    logFilePath = path.join(storagePath, 'telemetry_session_log.jsonl');
    outputChannel.appendLine(`Logs saving to: ${logFilePath}`);

    // Flush aggregated stats on a timer instead of logging every event
    flushTimer = setInterval(() => flushStats('interval'), FLUSH_INTERVAL_MS);

    // ── LISTENER 1: Document Text Edits ──
    const docChangeListener = vscode.workspace.onDidChangeTextDocument((event) => {
        if (!loggingActive) {
            return;
        }
        if (event.document.uri.scheme !== 'file') {
            return;
        }

        const key = event.document.uri.toString();
        const currentTime = Date.now();
        const pauseDurationMs = currentTime - (lastEditTimestamp.get(key) ?? currentTime);
        lastEditTimestamp.set(key, currentTime);

        const fileName = path.basename(event.document.fileName);
        stats.filesTouched.add(fileName);

        event.contentChanges.forEach((change) => {
            const charsAdded = change.text.length;
            const charsDeleted = change.rangeLength;

            if (charsAdded === 0 && charsDeleted === 0) {
                return;
            }

            stats.charsAdded += charsAdded;
            stats.charsDeleted += charsDeleted;
            stats.totalPauseMs += pauseDurationMs;
            stats.pauseSamples += 1;

            // If this file has an active post-paste watch, count this edit toward
            // the "how much did they rework it" ratio (Scenarios 3 & 4).
            recordPostPasteEdit(key, charsAdded + charsDeleted);

            if (charsAdded > 10) {
                stats.pastesOrGenerated += 1;

                if (charsAdded >= PASTE_CHAR_THRESHOLD) {
                    const insertOffset = event.document.offsetAt(change.range.start);
                    const insertedText = change.text;
                    classifyPasteSource(event.document, insertedText, insertOffset)
                        .then((source) => {
                            stats.pasteEvents.push({ source, length: charsAdded });
                        })
                        .catch(() => {
                            stats.pasteEvents.push({ source: 'unknown', length: charsAdded });
                        });
                    startPostPasteWatch(key, charsAdded, currentTime);
                }
            } else if (charsDeleted > 0 && charsAdded === 0) {
                stats.deletions += 1;
            } else {
                stats.keystrokes += 1;
            }
        });
    });

    // ── LISTENER 2: Tab Switch ──
    const tabChangeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!loggingActive) {
            return;
        }
        if (!editor || editor.document.uri.scheme !== 'file') {
            return;
        }
        stats.tabSwitches += 1;
        stats.filesTouched.add(path.basename(editor.document.fileName));
    });

    // ── LISTENER 3: File Save ──
    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        if (!loggingActive) {
            return;
        }
        if (document.uri.scheme !== 'file') {
            return;
        }
        stats.fileSaves += 1;
        stats.filesTouched.add(path.basename(document.fileName));
    });

    // ── LISTENER 4: Debug Sessions ──
    const debugStartListener = vscode.debug.onDidStartDebugSession(() => {
        if (!loggingActive) return;
        stats.debugSessionsStarted += 1;
        noteRunEvent();
    });
    const debugEndListener = vscode.debug.onDidTerminateDebugSession(() => {
        if (!loggingActive) return;
        stats.debugSessionsEnded += 1;
        flushStats('debug_session_end'); // flush immediately on meaningful boundary
    });

    // ── LISTENER 5: Task Execution ──
    const taskStartListener = vscode.tasks.onDidStartTask(() => {
        if (!loggingActive) return;
        stats.tasksRun += 1;
        noteRunEvent();
    });

    // ── LISTENER 5b: Terminal shell execution (catches Code Runner & manual `python foo.py`,
    // which don't go through the Tasks/Debug APIs above but are common in lab settings) ──
    // Feature-detect: this API landed in VS Code 1.93 and older lab installs may not have it.
    const anyWindow = vscode.window as any;
    let terminalRunListener: vscode.Disposable | undefined;
    if (typeof anyWindow.onDidStartTerminalShellExecution === 'function') {
        terminalRunListener = anyWindow.onDidStartTerminalShellExecution(() => {
            if (!loggingActive) return;
            stats.tasksRun += 1;
            noteRunEvent();
        });
    } else {
        outputChannel.appendLine('[info] onDidStartTerminalShellExecution unavailable on this VS Code version — Code Runner / manual terminal runs will not be logged. Update VS Code to 1.93+ to enable this.');
    }

    // ── LISTENER 6: Git commits ──
    setupGitListener(context);

    // ── LISTENER 7: Window focus changes (proxy for "looked away") ──
    const focusListener = vscode.window.onDidChangeWindowState((state) => {
        if (!loggingActive) return;
        const now = Date.now();
        if (windowFocused && !state.focused) {
            // just lost focus
            windowFocused = false;
            focusLostAt = now;
        } else if (!windowFocused && state.focused) {
            // just regained focus
            windowFocused = true;
            const lostMs = now - focusLostAt;
            if (lostMs >= FOCUS_LOSS_MIN_MS) {
                stats.focusLossCount += 1;
                stats.totalFocusLossMs += lostMs;
            }
        }
    });

    // ── Commands: let anyone stop/resume logging without uninstalling the extension ──
    const stopCommand = vscode.commands.registerCommand('telemetryLogger.stopLogging', () => {
        if (!loggingActive) {
            vscode.window.showInformationMessage('Telemetry Logger is already stopped.');
            return;
        }
        loggingActive = false;
        flushStats('logging_stopped'); // save whatever was captured before stopping
        outputChannel.appendLine('--- Logging stopped by user ---');
        vscode.window.showInformationMessage('Telemetry Logger: logging stopped.');
    });
    const resumeCommand = vscode.commands.registerCommand('telemetryLogger.resumeLogging', () => {
        if (loggingActive) {
            vscode.window.showInformationMessage('Telemetry Logger is already running.');
            return;
        }
        loggingActive = true;
        stats = freshStats();
        outputChannel.appendLine('--- Logging resumed by user ---');
        vscode.window.showInformationMessage('Telemetry Logger: logging resumed.');
    });

    context.subscriptions.push(
        docChangeListener,
        tabChangeListener,
        saveListener,
        debugStartListener,
        debugEndListener,
        taskStartListener,
        focusListener,
        stopCommand,
        resumeCommand,
        { dispose: () => clearInterval(flushTimer) }
    );
    if (terminalRunListener) {
        context.subscriptions.push(terminalRunListener);
    }
}

async function setupGitListener(context: vscode.ExtensionContext) {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) {
        outputChannel.appendLine('[git] built-in git extension not found — commit tracking disabled');
        return;
    }

    const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = git.getAPI(1);
    const lastCommitHash = new Map<string, string>();

    const attachRepo = (repo: any) => {
        const rootPath = repo.rootUri.fsPath;
        lastCommitHash.set(rootPath, repo.state.HEAD?.commit ?? '');

        const disposable = repo.state.onDidChange(() => {
            const currentCommit = repo.state.HEAD?.commit;
            const previousCommit = lastCommitHash.get(rootPath);
            if (currentCommit && currentCommit !== previousCommit) {
                lastCommitHash.set(rootPath, currentCommit);
                stats.gitCommits += 1;
                flushStats('git_commit'); // commits are meaningful — flush right away
            }
        });
        context.subscriptions.push(disposable);
    };

    api.repositories.forEach(attachRepo);
    context.subscriptions.push(api.onDidOpenRepository(attachRepo));
}

export function deactivate() {
    flushStats('deactivate');
    if (outputChannel) {
        outputChannel.appendLine('--- Telemetry Logger Deactivated ---');
    }
}