import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────
const CAPTURE_TEXT_SNIPPETS = false;
const FLUSH_INTERVAL_MS = 30_000; // write a summary every 30s instead of per-event

let outputChannel: vscode.OutputChannel;
let logFilePath: string;
let flushTimer: NodeJS.Timeout;

const lastEditTimestamp = new Map<string, number>();

let writeQueue: Promise<void> = Promise.resolve();
function enqueueWrite(line: string) {
    writeQueue = writeQueue
        .then(() => fs.promises.appendFile(logFilePath, line + '\n'))
        .catch((err) => outputChannel.appendLine(`[write error] ${err}`));
}

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
    };
}

let stats = freshStats();

function flushStats(reason: string) {
    if (
        stats.keystrokes === 0 &&
        stats.tabSwitches === 0 &&
        stats.fileSaves === 0 &&
        stats.debugSessionsStarted === 0 &&
        stats.tasksRun === 0 &&
        stats.gitCommits === 0
    ) {
        return; // nothing happened this window — skip empty summaries
    }

    const summary = {
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
    };

    const jsonString = JSON.stringify(summary);
    outputChannel.appendLine(jsonString);
    enqueueWrite(jsonString);

    stats = freshStats();
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Telemetry Logger');
    outputChannel.appendLine('--- Telemetry Logger Activated ---');

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

            if (charsAdded > 10) {
                stats.pastesOrGenerated += 1;
            } else if (charsDeleted > 0 && charsAdded === 0) {
                stats.deletions += 1;
            } else {
                stats.keystrokes += 1;
            }
        });
    });

    // ── LISTENER 2: Tab Switch ──
    const tabChangeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || editor.document.uri.scheme !== 'file') {
            return;
        }
        stats.tabSwitches += 1;
        stats.filesTouched.add(path.basename(editor.document.fileName));
    });

    // ── LISTENER 3: File Save ──
    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme !== 'file') {
            return;
        }
        stats.fileSaves += 1;
        stats.filesTouched.add(path.basename(document.fileName));
    });

    // ── LISTENER 4: Debug Sessions ──
    const debugStartListener = vscode.debug.onDidStartDebugSession(() => {
        stats.debugSessionsStarted += 1;
    });
    const debugEndListener = vscode.debug.onDidTerminateDebugSession(() => {
        stats.debugSessionsEnded += 1;
        flushStats('debug_session_end'); // flush immediately on meaningful boundary
    });

    // ── LISTENER 5: Task Execution ──
    const taskStartListener = vscode.tasks.onDidStartTask(() => {
        stats.tasksRun += 1;
    });

    // ── LISTENER 6: Git commits ──
    setupGitListener(context);

    context.subscriptions.push(
        docChangeListener,
        tabChangeListener,
        saveListener,
        debugStartListener,
        debugEndListener,
        taskStartListener,
        { dispose: () => clearInterval(flushTimer) }
    );
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