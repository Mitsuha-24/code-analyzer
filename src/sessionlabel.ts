// sessionLabel.ts - asks "how will you code this session?" + "which task?" at session start.
import * as vscode from 'vscode';

export type SessionMode = 'human' | 'ai_assisted' | 'mixed';

export interface SessionTag {
    label: SessionMode;
    taskId: string;
}

const TASKS = [
    'T1-Simple Program',
    'T2-Medium Level Program',
    'T3-Hard Level Program',
    'other'
];

export async function promptSessionTag(): Promise<SessionTag | undefined> {
    const mode = await vscode.window.showQuickPick(
        [
            { label: 'Human only', description: 'Copilot/ChatGPT off, no outside pasting', value: 'human' as SessionMode },
            { label: 'AI-assisted', description: 'Copilot on, or paste/accept AI code', value: 'ai_assisted' as SessionMode },
            { label: 'Mixed', description: 'Mostly typed, a few AI suggestions accepted', value: 'mixed' as SessionMode }
        ],
        { title: 'CodeTrace: how will you write code this session?', ignoreFocusOut: true }
    );
    if (!mode) { return undefined; }

    const task = await vscode.window.showQuickPick(TASKS, {
        title: 'CodeTrace: which task?',
        ignoreFocusOut: true
    });
    if (!task) { return undefined; }

    return { label: mode.value, taskId: task };
}