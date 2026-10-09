import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { randomUUID } from 'crypto';

// ============================================================================
// CONFIGURATION
// ============================================================================

const FLUSH_INTERVAL_MS = 60_000;

// Large insertions are tracked as INSERTION EVENTS.
// They are NOT automatically considered AI-generated.
const LARGE_INSERTION_THRESHOLD = 15;

const EDIT_RATIO_WINDOW_MS = 3 * 60_000;
const RUN_AFTER_INSERTION_WINDOW_MS = 2 * 60_000;

const FOCUS_LOSS_MIN_MS = 3_000;
const SERVER_POST_TIMEOUT_MS = 4_000;

// Maximum number of raw events retained in memory before a flush.
const MAX_RAW_EVENTS_PER_WINDOW = 2_000;

// ============================================================================
// TYPES
// ============================================================================

type PasteSource =
    | 'same_file'
    | 'other_open_file'
    | 'external_clipboard'
    | 'unknown';

type EventType =
    | 'edit'
    | 'large_insertion'
    | 'deletion'
    | 'save'
    | 'tab_switch'
    | 'debug_start'
    | 'debug_end'
    | 'task_start'
    | 'terminal_run'
    | 'git_commit'
    | 'focus_loss'
    | 'focus_gain'
    | 'diagnostic_change';

interface PasteEvent {
    source: PasteSource;
    length: number;
}

interface TelemetryEvent {
    eventId: string;
    sessionId: string;
    timestamp: string;
    eventType: EventType;

    file?: string;
    language?: string;

    charsAdded?: number;
    charsDeleted?: number;
    changeCount?: number;

    insertionSize?: number;
    deletionSize?: number;

    pasteSource?: PasteSource;

    diagnosticsErrors?: number;
    diagnosticsWarnings?: number;

    durationMs?: number;
}

interface PostInsertionWatch {
    fileKey: string;
    timestamp: number;
    insertionLength: number;
    charsChangedSince: number;
}

interface SessionStats {
    windowStart: string;

    // Editing
    editEvents: number;
    insertionEvents: number;
    deletionEvents: number;
    replacementEvents: number;

    charsAdded: number;
    charsDeleted: number;

    largeInsertionCount: number;
    largestInsertionSize: number;
    largestDeletionSize: number;

    totalInsertionSize: number;
    totalDeletionSize: number;

    // Timing
    totalPauseMs: number;
    pauseSamples: number;

    activeCodingTimeMs: number;
    idleTimeMs: number;

    // Development workflow
    tabSwitches: number;
    fileSaves: number;

    debugSessionsStarted: number;
    debugSessionsEnded: number;

    tasksRun: number;
    terminalRuns: number;

    gitCommits: number;

    // Diagnostics
    diagnosticEvents: number;
    diagnosticErrorCount: number;
    diagnosticWarningCount: number;

    // Files / languages
    filesTouched: Set<string>;
    languagesUsed: Set<string>;

    // Insertion / paste behavior
    pasteEvents: PasteEvent[];
    editRatiosPostInsertion: number[];
    runsShortlyAfterInsertion: number;

    // Focus behavior
    focusLossCount: number;
    totalFocusLossMs: number;

    // Raw event sequence
    rawEvents: TelemetryEvent[];
}

// ============================================================================
// GLOBAL STATE
// ============================================================================

let outputChannel: vscode.OutputChannel;

let logFilePath = '';
let eventLogFilePath = '';
let snapshotLogFilePath = '';

let flushTimer: NodeJS.Timeout | undefined;

let studentId = 'unknown';
let sessionId = '';

let loggingActive = false;
let consentGiven = false;

let projectId = 'unknown';
let taskId = 'unknown';

const lastEditTimestamp = new Map<string, number>();

let writeQueue: Promise<void> = Promise.resolve();

const activeInsertionWatches = new Map<string, PostInsertionWatch>();

let lastInsertionTimestamp = 0;

let windowFocused = true;
let focusLostAt = 0;

// Current stats window.
let stats = freshStats();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateSessionId(): string {
    return `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function generateEventId(): string {
    return randomUUID();
}

function average(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    return Math.round(
        (values.reduce((a, b) => a + b, 0) / values.length) * 100
    ) / 100;
}

function median(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return Math.round(
            ((sorted[middle - 1] + sorted[middle]) / 2) * 100
        ) / 100;
    }

    return sorted[middle];
}

function languageFromDocument(document: vscode.TextDocument): string {
    return document.languageId || 'unknown';
}

function fileNameFromDocument(document: vscode.TextDocument): string {
    return path.basename(document.fileName);
}

function getProjectId(): string {
    const folders = vscode.workspace.workspaceFolders;

    if (!folders || folders.length === 0) {
        return 'no-workspace';
    }

    // Use workspace name rather than an absolute path for privacy.
    return folders.length === 1
        ? folders[0].name
        : folders.map((folder) => folder.name).join('|');
}

// ============================================================================
// WRITE QUEUE
// ============================================================================

function enqueueWrite(filePath: string, line: string): void {
    writeQueue = writeQueue
        .then(() => fs.promises.appendFile(filePath, line + '\n'))
        .catch((error) => {
            if (outputChannel) {
                outputChannel.appendLine(
                    `[write error] ${error instanceof Error ? error.message : String(error)}`
                );
            }
        });
}

// ============================================================================
// RAW EVENT LOGGING
// ============================================================================

function recordEvent(event: Omit<TelemetryEvent, 'eventId' | 'sessionId'>): void {
    if (!loggingActive || !consentGiven) {
        return;
    }

    if (stats.rawEvents.length < MAX_RAW_EVENTS_PER_WINDOW) {
        stats.rawEvents.push({
            eventId: generateEventId(),
            sessionId,
            ...event
        });
    }
}

// ============================================================================
// STATS
// ============================================================================

function freshStats(): SessionStats {
    return {
        windowStart: new Date().toISOString(),

        editEvents: 0,
        insertionEvents: 0,
        deletionEvents: 0,
        replacementEvents: 0,

        charsAdded: 0,
        charsDeleted: 0,

        largeInsertionCount: 0,
        largestInsertionSize: 0,
        largestDeletionSize: 0,

        totalInsertionSize: 0,
        totalDeletionSize: 0,

        totalPauseMs: 0,
        pauseSamples: 0,

        activeCodingTimeMs: 0,
        idleTimeMs: 0,

        tabSwitches: 0,
        fileSaves: 0,

        debugSessionsStarted: 0,
        debugSessionsEnded: 0,

        tasksRun: 0,
        terminalRuns: 0,

        gitCommits: 0,

        diagnosticEvents: 0,
        diagnosticErrorCount: 0,
        diagnosticWarningCount: 0,

        filesTouched: new Set<string>(),
        languagesUsed: new Set<string>(),

        pasteEvents: [],
        editRatiosPostInsertion: [],
        runsShortlyAfterInsertion: 0,

        focusLossCount: 0,
        totalFocusLossMs: 0,

        rawEvents: []
    };
}

// ============================================================================
// SERVER
// ============================================================================

function getServerUrl(): string | undefined {
    const configured =
        vscode.workspace
            .getConfiguration('telemetryLogger')
            .get<string>('serverUrl');

    if (!configured || configured.trim().length === 0) {
        return undefined;
    }

    return configured.trim();
}

function postToServer(jsonPayload: string): void {
    const url = getServerUrl();

    if (!url) {
        return;
    }

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        outputChannel.appendLine(
            `[server] invalid serverUrl setting: ${url}`
        );
        return;
    }

    const isHttps = parsed.protocol === 'https:';

    // Pick the transport that actually matches the collector URL's scheme.
    // Using http.request against an https:// URL silently fails (connection
    // reset / protocol mismatch) rather than throwing something obvious, so
    // this branch matters even though the two request signatures are nearly
    // identical.
    const client = isHttps ? https : http;

    const req = client.request(
        {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname || '/ingest',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(jsonPayload)
            },
            timeout: SERVER_POST_TIMEOUT_MS
        },
        (res) => {
            res.resume();

            if (res.statusCode && res.statusCode >= 400) {
                outputChannel.appendLine(
                    `[server] ingest rejected: HTTP ${res.statusCode}`
                );
            }
        }
    );

    req.on('timeout', () => {
        req.destroy();
    });

    req.on('error', (error) => {
        outputChannel.appendLine(
            `[server] post failed (kept locally): ${error.message}`
        );
    });

    req.write(jsonPayload);
    req.end();
}

// ============================================================================
// CODE SNAPSHOTS
//
// Behavioral telemetry alone can't feed the Source Code Analysis stage of
// the pipeline (AST structure, static metrics, per-session code history).
// This section adds that missing data source.
//
// Deliberately NOT interval-based: capturing full file content every flush
// (60s) would multiply payload size and disk/network load for little gain,
// since code changes far less often than behavioral events fire. Instead,
// snapshots are taken at natural checkpoints:
//   - 'save'                on every file save (already-logged event)
//   - 'file_close'           when a file is closed (catches unsaved edits
//                             right before a window/editor close, which is
//                             the main risk of losing the true final state)
//   - 'session_stop'         when the user runs "Stop Logging"
//   - 'session_deactivate'   on extension deactivate, as a last-resort net
//
// Together these guarantee the final submitted code is captured even if the
// student never explicitly stops logging or saves immediately before
// closing the window.
// ============================================================================

type SnapshotTrigger =
    | 'save'
    | 'file_close'
    | 'session_stop'
    | 'session_deactivate';

function buildSnapshotPayload(
    document: vscode.TextDocument,
    trigger: SnapshotTrigger
): string {
    return JSON.stringify({
        schemaVersion: '2.0',
        payloadType: 'code_snapshot',

        sessionId,
        studentId,

        projectId,
        taskId,

        machineId: vscode.env.machineId,

        timestamp: new Date().toISOString(),
        trigger,

        file: fileNameFromDocument(document),
        language: languageFromDocument(document),

        content: document.getText()
    });
}

function captureCodeSnapshot(
    document: vscode.TextDocument,
    trigger: SnapshotTrigger
): void {
    if (!consentGiven || document.uri.scheme !== 'file') {
        return;
    }

    if (!snapshotLogFilePath) {
        return;
    }

    const jsonString = buildSnapshotPayload(document, trigger);

    // Session-ending triggers get a synchronous local write in addition to
    // (not instead of) the network post: the extension host can be torn
    // down moments after deactivate() / a window close, before the async
    // write queue or an in-flight HTTP request would otherwise finish. A
    // synchronous append guarantees the snapshot survives on disk even if
    // the network call never completes.
    if (
        trigger === 'session_stop' ||
        trigger === 'session_deactivate' ||
        trigger === 'file_close'
    ) {
        try {
            fs.appendFileSync(
                snapshotLogFilePath,
                jsonString + '\n'
            );
        } catch (error) {
            if (outputChannel) {
                outputChannel.appendLine(
                    `[snapshot write error] ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
    } else {
        enqueueWrite(snapshotLogFilePath, jsonString);
    }

    postToServer(jsonString);
}

function captureAllOpenDocuments(trigger: SnapshotTrigger): void {
    for (const document of vscode.workspace.textDocuments) {
        captureCodeSnapshot(document, trigger);
    }
}

// ============================================================================
// INSERTION SOURCE CLASSIFICATION
// ============================================================================

/**
 * This is deliberately called "paste source classification".
 *
 * IMPORTANT:
 * An external clipboard does NOT mean AI-generated.
 * It may be ChatGPT, a browser, documentation, another project, etc.
 */
async function classifyPasteSource(
    document: vscode.TextDocument,
    insertedText: string,
    insertOffset: number
): Promise<PasteSource> {
    const needle = insertedText.trim();

    if (needle.length < LARGE_INSERTION_THRESHOLD) {
        return 'unknown';
    }

    // ---------------------------------------------------------
    // 1. Same file
    // ---------------------------------------------------------

    const fullText = document.getText();

    const before = fullText.slice(0, insertOffset);
    const after = fullText.slice(
        insertOffset + insertedText.length
    );

    if (before.includes(needle) || after.includes(needle)) {
        return 'same_file';
    }

    // ---------------------------------------------------------
    // 2. Other currently-open file
    // ---------------------------------------------------------

    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.toString() === document.uri.toString()) {
            continue;
        }

        try {
            if (doc.getText().includes(needle)) {
                return 'other_open_file';
            }
        } catch {
            // Ignore inaccessible documents.
        }
    }

    // ---------------------------------------------------------
    // 3. Clipboard
    // ---------------------------------------------------------

    try {
        const clipboard = (
            await vscode.env.clipboard.readText()
        ).trim();

        if (
            clipboard.length > 0 &&
            (
                clipboard === needle ||
                clipboard.includes(needle) ||
                needle.includes(clipboard)
            )
        ) {
            return 'external_clipboard';
        }
    } catch {
        // Clipboard access may fail.
    }

    return 'unknown';
}

// ============================================================================
// POST-INSERTION ANALYSIS
// ============================================================================

function startPostInsertionWatch(
    fileKey: string,
    insertionLength: number,
    timestamp: number
): void {
    activeInsertionWatches.set(fileKey, {
        fileKey,
        timestamp,
        insertionLength,
        charsChangedSince: 0
    });

    lastInsertionTimestamp = timestamp;
}

function recordPostInsertionEdit(
    fileKey: string,
    charsChanged: number
): void {
    const watch = activeInsertionWatches.get(fileKey);

    if (!watch) {
        return;
    }

    if (Date.now() - watch.timestamp > EDIT_RATIO_WINDOW_MS) {
        settleInsertionWatch(fileKey);
        return;
    }

    watch.charsChangedSince += charsChanged;
}

function settleInsertionWatch(fileKey: string): void {
    const watch = activeInsertionWatches.get(fileKey);

    if (!watch) {
        return;
    }

    const ratio =
        watch.insertionLength > 0
            ? watch.charsChangedSince / watch.insertionLength
            : 0;

    stats.editRatiosPostInsertion.push(
        Math.round(ratio * 100) / 100
    );

    activeInsertionWatches.delete(fileKey);
}

function settleExpiredInsertionWatches(): void {
    const now = Date.now();

    for (const [fileKey, watch] of activeInsertionWatches) {
        if (
            now - watch.timestamp >
            EDIT_RATIO_WINDOW_MS
        ) {
            settleInsertionWatch(fileKey);
        }
    }
}

function noteRunEvent(): void {
    if (lastInsertionTimestamp === 0) {
        return;
    }

    if (
        Date.now() - lastInsertionTimestamp <=
        RUN_AFTER_INSERTION_WINDOW_MS
    ) {
        stats.runsShortlyAfterInsertion += 1;
    }
}

// ============================================================================
// STUDENT / CONSENT
// ============================================================================

async function requestConsent(
    context: vscode.ExtensionContext
): Promise<boolean> {
    const storedConsent =
        context.globalState.get<boolean>(
            'telemetryLogger.consent'
        );

    if (storedConsent === true) {
        return true;
    }

    const result = await vscode.window.showInformationMessage(
        'Telemetry Logger collects coding-behavior metadata such as edit counts, timing, execution, debugging, Git activity, and focus changes. It also captures snapshots of your source code file content — when you save a file, close a file, and when logging stops or ends — to support code-structure analysis for the research project. Do you consent to telemetry and code-snapshot collection for the research project?',
        {
            modal: true
        },
        'Allow',
        'Decline'
    );

    if (result !== 'Allow') {
        await context.globalState.update(
            'telemetryLogger.consent',
            false
        );

        return false;
    }

    await context.globalState.update(
        'telemetryLogger.consent',
        true
    );

    return true;
}

async function resolveStudentId(
    context: vscode.ExtensionContext
): Promise<string> {
    const stored =
        context.globalState.get<string>(
            'telemetryLogger.studentId'
        );

    if (stored && stored.trim().length > 0) {
        return stored;
    }

    const entered = await vscode.window.showInputBox({
        title: 'Lab Telemetry Logger',
        prompt:
            'Enter your research participant ID / student ID',
        ignoreFocusOut: true,
        password: false,
        validateInput: (value) => {
            return value.trim().length === 0
                ? 'Participant ID is required'
                : null;
        }
    });

    const id =
        entered && entered.trim().length > 0
            ? entered.trim()
            : `anon-${Date.now()}`;

    await context.globalState.update(
        'telemetryLogger.studentId',
        id
    );

    return id;
}

async function resolveTaskId(): Promise<string> {
    const configured =
        vscode.workspace
            .getConfiguration('telemetryLogger')
            .get<string>('taskId');

    if (configured && configured.trim().length > 0) {
        return configured.trim();
    }

    // Do not force the student to enter a task every time.
    // "unknown" can later be assigned during controlled experiments.
    return 'unknown';
}

// ============================================================================
// FLUSH
// ============================================================================

function flushStats(reason: string): void {
    if (!loggingActive || !consentGiven) {
        return;
    }

    settleExpiredInsertionWatches();

    const hasActivity =
        stats.editEvents > 0 ||
        stats.tabSwitches > 0 ||
        stats.fileSaves > 0 ||
        stats.debugSessionsStarted > 0 ||
        stats.tasksRun > 0 ||
        stats.terminalRuns > 0 ||
        stats.gitCommits > 0 ||
        stats.largeInsertionCount > 0 ||
        stats.focusLossCount > 0 ||
        stats.diagnosticEvents > 0 ||
        stats.rawEvents.length > 0;

    if (!hasActivity) {
        return;
    }

    const pasteBySource = {
        same_file: 0,
        other_open_file: 0,
        external_clipboard: 0,
        unknown: 0
    };

    stats.pasteEvents.forEach((paste) => {
        pasteBySource[paste.source]++;
    });

    const now = new Date();

    const windowDurationMs =
        now.getTime() -
        new Date(stats.windowStart).getTime();

    const avgPauseMs =
        stats.pauseSamples > 0
            ? Math.round(
                stats.totalPauseMs /
                stats.pauseSamples
            )
            : 0;

    const avgInsertionSize =
        stats.insertionEvents > 0
            ? Math.round(
                stats.totalInsertionSize /
                stats.insertionEvents *
                100
            ) / 100
            : 0;

    const avgDeletionSize =
        stats.deletionEvents > 0
            ? Math.round(
                stats.totalDeletionSize /
                stats.deletionEvents *
                100
            ) / 100
            : 0;

    const summary = {
        schemaVersion: '2.0',

        sessionId,
        studentId,

        projectId,
        taskId,

        machineId: vscode.env.machineId,

        windowStart: stats.windowStart,
        windowEnd: now.toISOString(),

        windowDurationMs,

        reason,

        // ---------------------------------------------------------
        // Editing behavior
        // ---------------------------------------------------------

        editEvents: stats.editEvents,
        insertionEvents: stats.insertionEvents,
        deletionEvents: stats.deletionEvents,
        replacementEvents: stats.replacementEvents,

        charsAdded: stats.charsAdded,
        charsDeleted: stats.charsDeleted,

        largeInsertionCount:
            stats.largeInsertionCount,

        largestInsertionSize:
            stats.largestInsertionSize,

        largestDeletionSize:
            stats.largestDeletionSize,

        avgInsertionSize,
        avgDeletionSize,

        // ---------------------------------------------------------
        // Timing behavior
        // ---------------------------------------------------------

        avgPauseMs,

        medianPauseMs: median(
            collectPauseSamples()
        ),

        activeCodingTimeMs:
            stats.activeCodingTimeMs,

        idleTimeMs:
            stats.idleTimeMs,

        // ---------------------------------------------------------
        // Development workflow
        // ---------------------------------------------------------

        tabSwitches:
            stats.tabSwitches,

        fileSaves:
            stats.fileSaves,

        debugSessionsStarted:
            stats.debugSessionsStarted,

        debugSessionsEnded:
            stats.debugSessionsEnded,

        tasksRun:
            stats.tasksRun,

        terminalRuns:
            stats.terminalRuns,

        gitCommits:
            stats.gitCommits,

        // ---------------------------------------------------------
        // Diagnostics
        // ---------------------------------------------------------

        diagnosticEvents:
            stats.diagnosticEvents,

        diagnosticErrorCount:
            stats.diagnosticErrorCount,

        diagnosticWarningCount:
            stats.diagnosticWarningCount,

        // ---------------------------------------------------------
        // Context
        // ---------------------------------------------------------

        filesTouched:
            Array.from(stats.filesTouched),

        languagesUsed:
            Array.from(stats.languagesUsed),

        // ---------------------------------------------------------
        // Insertion / paste behavior
        // ---------------------------------------------------------

        pasteSourceBreakdown:
            pasteBySource,

        avgEditRatioPostInsertion:
            average(
                stats.editRatiosPostInsertion
            ),

        runsShortlyAfterInsertion:
            stats.runsShortlyAfterInsertion,

        // ---------------------------------------------------------
        // Focus behavior
        // ---------------------------------------------------------

        focusLossCount:
            stats.focusLossCount,

        avgFocusLossMs:
            stats.focusLossCount > 0
                ? Math.round(
                    stats.totalFocusLossMs /
                    stats.focusLossCount
                )
                : 0,

        // ---------------------------------------------------------
        // Ground truth
        //
        // IMPORTANT:
        // These are intentionally "unknown" here.
        // They should be assigned by the controlled dataset
        // collection process rather than guessed by telemetry.
        // ---------------------------------------------------------

        aiUsage: 'unknown',
        aiTool: 'unknown',
        aiAssistanceLevel: 'unknown',

        // ---------------------------------------------------------
        // Event sequence
        // ---------------------------------------------------------

        eventCount:
            stats.rawEvents.length,

        events:
            stats.rawEvents
    };

    const jsonString = JSON.stringify(summary);

    outputChannel.appendLine(
        `[telemetry] ${summary.windowStart} -> ${summary.windowEnd}`
    );

    enqueueWrite(
        logFilePath,
        jsonString
    );

    postToServer(jsonString);

    stats = freshStats();
}

// ============================================================================
// PAUSE SAMPLE STORAGE
// ============================================================================

// The original logger calculated average pauses but did not retain the
// individual pause values. Keeping a small sample makes median calculation
// possible without storing unlimited timing information.

let pauseSamplesForMedian: number[] = [];

function addPauseSample(value: number): void {
    // Prevent unreasonable values from dominating the research features.
    const clamped = Math.min(
        Math.max(value, 0),
        30 * 60 * 1000
    );

    pauseSamplesForMedian.push(clamped);

    // Keep only the latest 500 samples in the current window.
    if (pauseSamplesForMedian.length > 500) {
        pauseSamplesForMedian =
            pauseSamplesForMedian.slice(-500);
    }
}

function collectPauseSamples(): number[] {
    return [...pauseSamplesForMedian];
}

// ============================================================================
// DIAGNOSTICS
// ============================================================================

function collectDiagnosticsForDocument(
    document: vscode.TextDocument
): void {
    const diagnostics =
        vscode.languages.getDiagnostics(
            document.uri
        );

    let errors = 0;
    let warnings = 0;

    for (const diagnostic of diagnostics) {
        if (
            diagnostic.severity ===
            vscode.DiagnosticSeverity.Error
        ) {
            errors++;
        } else if (
            diagnostic.severity ===
            vscode.DiagnosticSeverity.Warning
        ) {
            warnings++;
        }
    }

    stats.diagnosticEvents++;
    stats.diagnosticErrorCount += errors;
    stats.diagnosticWarningCount += warnings;

    recordEvent({
        timestamp: new Date().toISOString(),
        eventType: 'diagnostic_change',
        file: fileNameFromDocument(document),
        language: languageFromDocument(document),
        diagnosticsErrors: errors,
        diagnosticsWarnings: warnings
    });
}

// ============================================================================
// ACTIVATION
// ============================================================================

export async function activate(
    context: vscode.ExtensionContext
): Promise<void> {
    outputChannel =
        vscode.window.createOutputChannel(
            'Telemetry Logger'
        );

    outputChannel.appendLine(
        '--- Telemetry Logger Activated ---'
    );

    // ---------------------------------------------------------
    // Consent
    // ---------------------------------------------------------

    consentGiven =
        await requestConsent(context);

    if (!consentGiven) {
        outputChannel.appendLine(
            '--- Telemetry collection declined ---'
        );

        vscode.window.showInformationMessage(
            'Telemetry Logger: collection is disabled.'
        );

        return;
    }

    // ---------------------------------------------------------
    // Session
    // ---------------------------------------------------------

    sessionId = generateSessionId();

    studentId =
        await resolveStudentId(context);

    projectId =
        getProjectId();

    taskId =
        await resolveTaskId();

    loggingActive = true;

    outputChannel.appendLine(
        `Session ID: ${sessionId}`
    );

    outputChannel.appendLine(
        `Participant ID: ${studentId}`
    );

    outputChannel.appendLine(
        `Project ID: ${projectId}`
    );

    outputChannel.appendLine(
        `Task ID: ${taskId}`
    );

    // ---------------------------------------------------------
    // Storage
    // ---------------------------------------------------------

    const storagePath =
        context.globalStorageUri.fsPath;

    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, {
            recursive: true
        });
    }

    logFilePath = path.join(
        storagePath,
        'telemetry_session_log.jsonl'
    );

    eventLogFilePath = path.join(
        storagePath,
        'telemetry_event_log.jsonl'
    );

    snapshotLogFilePath = path.join(
        storagePath,
        'telemetry_code_snapshots.jsonl'
    );

    outputChannel.appendLine(
        `Summary logs: ${logFilePath}`
    );

    outputChannel.appendLine(
        `Event logs: ${eventLogFilePath}`
    );

    outputChannel.appendLine(
        `Snapshot logs: ${snapshotLogFilePath}`
    );

    // ---------------------------------------------------------
    // Periodic flush
    // ---------------------------------------------------------

    flushTimer = setInterval(
        () => {
            flushStats('interval');
        },
        FLUSH_INTERVAL_MS
    );

    // ========================================================================
    // LISTENER 1: DOCUMENT EDITS
    // ========================================================================

    const docChangeListener =
        vscode.workspace.onDidChangeTextDocument(
            (event) => {
                if (!loggingActive) {
                    return;
                }

                if (
                    event.document.uri.scheme !==
                    'file'
                ) {
                    return;
                }

                const key =
                    event.document.uri.toString();

                const currentTime =
                    Date.now();

                const previousTime =
                    lastEditTimestamp.get(
                        key
                    );

                const pauseDurationMs =
                    previousTime === undefined
                        ? 0
                        : currentTime -
                        previousTime;

                lastEditTimestamp.set(
                    key,
                    currentTime
                );

                const fileName =
                    fileNameFromDocument(
                        event.document
                    );

                const language =
                    languageFromDocument(
                        event.document
                    );

                stats.filesTouched.add(
                    fileName
                );

                stats.languagesUsed.add(
                    language
                );

                if (pauseDurationMs > 0) {
                    stats.totalPauseMs +=
                        pauseDurationMs;

                    stats.pauseSamples += 1;

                    addPauseSample(
                        pauseDurationMs
                    );

                    // We treat pauses over 5 minutes as idle
                    // time rather than active coding time.
                    if (
                        pauseDurationMs >
                        5 * 60 * 1000
                    ) {
                        stats.idleTimeMs +=
                            pauseDurationMs;
                    } else {
                        stats.activeCodingTimeMs +=
                            pauseDurationMs;
                    }
                }

                event.contentChanges.forEach(
                    (change) => {
                        const charsAdded =
                            change.text.length;

                        const charsDeleted =
                            change.rangeLength;

                        if (
                            charsAdded === 0 &&
                            charsDeleted === 0
                        ) {
                            return;
                        }

                        stats.editEvents++;

                        stats.charsAdded +=
                            charsAdded;

                        stats.charsDeleted +=
                            charsDeleted;

                        stats.totalInsertionSize +=
                            charsAdded;

                        stats.totalDeletionSize +=
                            charsDeleted;

                        if (
                            charsAdded > 0 &&
                            charsDeleted > 0
                        ) {
                            stats.replacementEvents++;
                        } else if (
                            charsAdded > 0
                        ) {
                            stats.insertionEvents++;
                        } else if (
                            charsDeleted > 0
                        ) {
                            stats.deletionEvents++;
                        }

                        stats.largestInsertionSize =
                            Math.max(
                                stats.largestInsertionSize,
                                charsAdded
                            );

                        stats.largestDeletionSize =
                            Math.max(
                                stats.largestDeletionSize,
                                charsDeleted
                            );

                        recordPostInsertionEdit(
                            key,
                            charsAdded +
                            charsDeleted
                        );

                        // -----------------------------------------------------
                        // Large insertion
                        // -----------------------------------------------------

                        if (
                            charsAdded >=
                            LARGE_INSERTION_THRESHOLD
                        ) {
                            stats.largeInsertionCount++;

                            const insertOffset =
                                event.document.offsetAt(
                                    change.range.start
                                );

                            const insertedText =
                                change.text;

                            startPostInsertionWatch(
                                key,
                                charsAdded,
                                currentTime
                            );

                            // We only classify the source.
                            // We DO NOT classify it as AI.
                            classifyPasteSource(
                                event.document,
                                insertedText,
                                insertOffset
                            )
                                .then((source) => {
                                    stats.pasteEvents.push(
                                        {
                                            source,
                                            length:
                                                charsAdded
                                        }
                                    );
                                })
                                .catch(() => {
                                    stats.pasteEvents.push(
                                        {
                                            source:
                                                'unknown',
                                            length:
                                                charsAdded
                                        }
                                    );
                                });

                            recordEvent({
                                timestamp:
                                    new Date().toISOString(),
                                eventType:
                                    'large_insertion',
                                file: fileName,
                                language,
                                insertionSize:
                                    charsAdded,
                                charsDeleted
                            });

                            return;
                        }

                        // -----------------------------------------------------
                        // Deletion
                        // -----------------------------------------------------

                        if (
                            charsDeleted > 0 &&
                            charsAdded === 0
                        ) {
                            recordEvent({
                                timestamp:
                                    new Date().toISOString(),
                                eventType:
                                    'deletion',
                                file: fileName,
                                language,
                                deletionSize:
                                    charsDeleted
                            });

                            return;
                        }

                        // -----------------------------------------------------
                        // Normal edit
                        // -----------------------------------------------------

                        recordEvent({
                            timestamp:
                                new Date().toISOString(),
                            eventType: 'edit',
                            file: fileName,
                            language,
                            charsAdded,
                            charsDeleted
                        });
                    }
                );
            }
        );

    // ========================================================================
    // LISTENER 2: ACTIVE EDITOR / TAB SWITCH
    // ========================================================================

    const tabChangeListener =
        vscode.window.onDidChangeActiveTextEditor(
            (editor) => {
                if (!loggingActive) {
                    return;
                }

                if (
                    !editor ||
                    editor.document.uri.scheme !==
                    'file'
                ) {
                    return;
                }

                const fileName =
                    fileNameFromDocument(
                        editor.document
                    );

                const language =
                    languageFromDocument(
                        editor.document
                    );

                stats.tabSwitches++;

                stats.filesTouched.add(
                    fileName
                );

                stats.languagesUsed.add(
                    language
                );

                recordEvent({
                    timestamp:
                        new Date().toISOString(),
                    eventType:
                        'tab_switch',
                    file: fileName,
                    language
                });
            }
        );

    // ========================================================================
    // LISTENER 3: FILE SAVE
    // ========================================================================

    const saveListener =
        vscode.workspace.onDidSaveTextDocument(
            (document) => {
                if (!loggingActive) {
                    return;
                }

                if (
                    document.uri.scheme !==
                    'file'
                ) {
                    return;
                }

                const fileName =
                    fileNameFromDocument(
                        document
                    );

                const language =
                    languageFromDocument(
                        document
                    );

                stats.fileSaves++;

                stats.filesTouched.add(
                    fileName
                );

                stats.languagesUsed.add(
                    language
                );

                recordEvent({
                    timestamp:
                        new Date().toISOString(),
                    eventType: 'save',
                    file: fileName,
                    language
                });

                captureCodeSnapshot(
                    document,
                    'save'
                );
            }
        );

    // ========================================================================
    // LISTENER 3b: DOCUMENT CLOSE (final-state safety net)
    // ========================================================================
    //
    // Fires when a file is closed, including as part of the window itself
    // closing — this is what catches unsaved edits typed right before the
    // student closes VS Code, which a save-only checkpoint would miss.

    const closeListener =
        vscode.workspace.onDidCloseTextDocument(
            (document) => {
                if (!loggingActive) {
                    return;
                }

                captureCodeSnapshot(
                    document,
                    'file_close'
                );
            }
        );

    // ========================================================================
    // LISTENER 4: DEBUG START
    // ========================================================================

    const debugStartListener =
        vscode.debug.onDidStartDebugSession(
            () => {
                if (!loggingActive) {
                    return;
                }

                stats.debugSessionsStarted++;

                noteRunEvent();

                recordEvent({
                    timestamp:
                        new Date().toISOString(),
                    eventType:
                        'debug_start'
                });
            }
        );

    // ========================================================================
    // LISTENER 5: DEBUG END
    // ========================================================================

    const debugEndListener =
        vscode.debug.onDidTerminateDebugSession(
            () => {
                if (!loggingActive) {
                    return;
                }

                stats.debugSessionsEnded++;

                recordEvent({
                    timestamp:
                        new Date().toISOString(),
                    eventType:
                        'debug_end'
                });

                flushStats(
                    'debug_session_end'
                );
            }
        );

    // ========================================================================
    // LISTENER 6: TASK EXECUTION
    // ========================================================================

    const taskStartListener =
        vscode.tasks.onDidStartTask(
            () => {
                if (!loggingActive) {
                    return;
                }

                stats.tasksRun++;

                noteRunEvent();

                recordEvent({
                    timestamp:
                        new Date().toISOString(),
                    eventType:
                        'task_start'
                });
            }
        );

    // ========================================================================
    // LISTENER 7: TERMINAL EXECUTION
    // ========================================================================

    const anyWindow =
        vscode.window as any;

    let terminalRunListener:
        vscode.Disposable | undefined;

    if (
        typeof anyWindow.onDidStartTerminalShellExecution ===
        'function'
    ) {
        terminalRunListener =
            anyWindow.onDidStartTerminalShellExecution(
                () => {
                    if (!loggingActive) {
                        return;
                    }

                    stats.tasksRun++;
                    stats.terminalRuns++;

                    noteRunEvent();

                    recordEvent({
                        timestamp:
                            new Date().toISOString(),
                        eventType:
                            'terminal_run'
                    });
                }
            );
    } else {
        outputChannel.appendLine(
            '[info] Terminal shell execution API unavailable. Update VS Code if terminal execution tracking is required.'
        );
    }

    // ========================================================================
    // LISTENER 8: DIAGNOSTICS
    // ========================================================================

    const diagnosticListener =
        vscode.languages.onDidChangeDiagnostics(
            (event) => {
                if (!loggingActive) {
                    return;
                }

                for (const uri of event.uris) {
                    if (
                        uri.scheme !==
                        'file'
                    ) {
                        continue;
                    }

                    const document =
                        vscode.workspace.textDocuments
                            .find(
                                (doc) =>
                                    doc.uri.toString() ===
                                    uri.toString()
                            );

                    if (document) {
                        collectDiagnosticsForDocument(
                            document
                        );
                    }
                }
            }
        );

    // ========================================================================
    // LISTENER 9: WINDOW FOCUS
    // ========================================================================

    const focusListener =
        vscode.window.onDidChangeWindowState(
            (state) => {
                if (!loggingActive) {
                    return;
                }

                const now =
                    Date.now();

                if (
                    windowFocused &&
                    !state.focused
                ) {
                    windowFocused = false;
                    focusLostAt = now;

                    recordEvent({
                        timestamp:
                            new Date().toISOString(),
                        eventType:
                            'focus_loss'
                    });
                } else if (
                    !windowFocused &&
                    state.focused
                ) {
                    windowFocused = true;

                    const lostMs =
                        now -
                        focusLostAt;

                    if (
                        lostMs >=
                        FOCUS_LOSS_MIN_MS
                    ) {
                        stats.focusLossCount++;

                        stats.totalFocusLossMs +=
                            lostMs;

                        recordEvent({
                            timestamp:
                                new Date().toISOString(),
                            eventType:
                                'focus_gain',
                            durationMs:
                                lostMs
                        });
                    }
                }
            }
        );

    // ========================================================================
    // COMMAND: STOP LOGGING
    // ========================================================================

    const stopCommand =
        vscode.commands.registerCommand(
            'telemetryLogger.stopLogging',
            () => {
                if (!loggingActive) {
                    vscode.window.showInformationMessage(
                        'Telemetry Logger is already stopped.'
                    );

                    return;
                }

                loggingActive = false;

                captureAllOpenDocuments(
                    'session_stop'
                );

                flushStats(
                    'logging_stopped'
                );

                outputChannel.appendLine(
                    '--- Logging stopped by user ---'
                );

                vscode.window.showInformationMessage(
                    'Telemetry Logger: logging stopped.'
                );
            }
        );

    // ========================================================================
    // COMMAND: RESUME LOGGING
    // ========================================================================

    const resumeCommand =
        vscode.commands.registerCommand(
            'telemetryLogger.resumeLogging',
            () => {
                if (!consentGiven) {
                    vscode.window.showWarningMessage(
                        'Telemetry Logger: research consent has not been granted.'
                    );

                    return;
                }

                if (loggingActive) {
                    vscode.window.showInformationMessage(
                        'Telemetry Logger is already running.'
                    );

                    return;
                }

                loggingActive = true;

                // A resumed period gets a fresh aggregation window.
                stats = freshStats();

                outputChannel.appendLine(
                    '--- Logging resumed by user ---'
                );

                vscode.window.showInformationMessage(
                    'Telemetry Logger: logging resumed.'
                );
            }
        );

    // ========================================================================
    // COMMAND: CLEAR CONSENT
    // ========================================================================

    const clearConsentCommand =
        vscode.commands.registerCommand(
            'telemetryLogger.clearConsent',
            async () => {
                loggingActive = false;

                await context.globalState.update(
                    'telemetryLogger.consent',
                    false
                );

                vscode.window.showInformationMessage(
                    'Telemetry Logger consent cleared. Restart the extension to provide consent again.'
                );
            }
        );

    // ========================================================================
    // REGISTER DISPOSABLES
    // ========================================================================

    context.subscriptions.push(
        docChangeListener,
        tabChangeListener,
        saveListener,
        closeListener,
        debugStartListener,
        debugEndListener,
        taskStartListener,
        diagnosticListener,
        focusListener,
        stopCommand,
        resumeCommand,
        clearConsentCommand,
        {
            dispose: () => {
                if (flushTimer) {
                    clearInterval(
                        flushTimer
                    );
                }
            }
        }
    );

    if (terminalRunListener) {
        context.subscriptions.push(
            terminalRunListener
        );
    }

    // ========================================================================
    // GIT
    // ========================================================================

    setupGitListener(context);

    outputChannel.appendLine(
        '--- Telemetry Logger Ready ---'
    );
}

// ============================================================================
// GIT LISTENER
// ============================================================================

async function setupGitListener(
    context: vscode.ExtensionContext
): Promise<void> {
    if (!loggingActive) {
        return;
    }

    const gitExtension =
        vscode.extensions.getExtension(
            'vscode.git'
        );

    if (!gitExtension) {
        outputChannel.appendLine(
            '[git] built-in Git extension not found — commit tracking disabled'
        );

        return;
    }

    try {
        const git =
            gitExtension.isActive
                ? gitExtension.exports
                : await gitExtension.activate();

        const api =
            git.getAPI(1);

        const lastCommitHash =
            new Map<string, string>();

        const attachRepo = (
            repo: any
        ) => {
            const rootPath =
                repo.rootUri.fsPath;

            lastCommitHash.set(
                rootPath,
                repo.state.HEAD?.commit ?? ''
            );

            const disposable =
                repo.state.onDidChange(
                    () => {
                        if (!loggingActive) {
                            return;
                        }

                        const currentCommit =
                            repo.state.HEAD?.commit;

                        const previousCommit =
                            lastCommitHash.get(
                                rootPath
                            );

                        if (
                            currentCommit &&
                            currentCommit !==
                            previousCommit
                        ) {
                            lastCommitHash.set(
                                rootPath,
                                currentCommit
                            );

                            stats.gitCommits++;

                            recordEvent({
                                timestamp:
                                    new Date().toISOString(),
                                eventType:
                                    'git_commit'
                            });

                            flushStats(
                                'git_commit'
                            );
                        }
                    }
                );

            context.subscriptions.push(
                disposable
            );
        };

        api.repositories.forEach(
            attachRepo
        );

        context.subscriptions.push(
            api.onDidOpenRepository(
                attachRepo
            )
        );

        outputChannel.appendLine(
            '[git] commit tracking enabled'
        );
    } catch (error) {
        outputChannel.appendLine(
            `[git] failed to initialize Git tracking: ${
                error instanceof Error
                    ? error.message
                    : String(error)
            }`
        );
    }
}

// ============================================================================
// DEACTIVATE
// ============================================================================

export function deactivate(): void {
    if (loggingActive) {
        captureAllOpenDocuments('session_deactivate');

        flushStats('deactivate');
    }

    if (outputChannel) {
        outputChannel.appendLine(
            '--- Telemetry Logger Deactivated ---'
        );

        outputChannel.dispose();
    }
}