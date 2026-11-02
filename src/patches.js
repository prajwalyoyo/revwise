'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const git = require('./git');
const rw = require('./rewrite');

const MAX_JOURNALED_PATCH = 2 * 1024 * 1024;

/** Opens a patch in an editor and offers to save or copy it. */
async function showPatch(text, defaultName = 'changes.patch') {
	if (!text.trim()) {
		vscode.window.showInformationMessage('Revwise: there are no changes to put in a patch.');
		return;
	}
	const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: text });
	await vscode.window.showTextDocument(doc, { preview: false });
	const pick = await vscode.window.showInformationMessage('Revwise: patch created.', 'Save As…', 'Copy to Clipboard');
	if (pick === 'Copy to Clipboard') {
		await vscode.env.clipboard.writeText(text);
		vscode.window.setStatusBarMessage('$(check) Patch copied', 2000);
	} else if (pick === 'Save As…') {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
		const target = await vscode.window.showSaveDialog({
			defaultUri: folder ? vscode.Uri.joinPath(folder, defaultName) : undefined,
			filters: { Patch: ['patch', 'diff'] },
		});
		if (target) {
			await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
			vscode.window.setStatusBarMessage(`$(check) Saved ${path.basename(target.fsPath)}`, 3000);
		}
	}
	return doc;
}

/** Reads patch text from a file URI, the active diff editor, or a file picker. */
async function readPatchInput(uri) {
	if (uri instanceof vscode.Uri) return { text: fs.readFileSync(uri.fsPath, 'utf8'), name: path.basename(uri.fsPath) };
	const ed = vscode.window.activeTextEditor;
	if (ed && (ed.document.languageId === 'diff' || /\.(patch|diff)$/i.test(ed.document.fileName))) {
		return { text: ed.document.getText(), name: path.basename(ed.document.fileName) };
	}
	const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Patch: ['patch', 'diff'], All: ['*'] } });
	if (!picked?.[0]) return undefined;
	return { text: fs.readFileSync(picked[0].fsPath, 'utf8'), name: path.basename(picked[0].fsPath) };
}

/**
 * Applies a patch. Mailbox patches (from format-patch) can be applied as commits (`git am -3`);
 * plain diffs go to the working tree (`git apply`), with a 3-way fallback. Both are journaled for undo.
 */
async function applyPatch(root, input, journal, { mode, onSequencer } = {}) {
	const { text, name } = input;
	if (!mode) {
		mode = 'apply';
		if (git.isMailboxPatch(text)) {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: '$(git-commit) Apply as commits', description: 'git am -3: recreates the commits with their authors and messages', mode: 'am' },
					{ label: '$(file-diff) Apply changes only', description: 'git apply: changes the working tree; you commit later', mode: 'apply' },
				],
				{ title: `Apply ${name}` },
			);
			if (!pick) return false;
			mode = pick.mode;
		}
	}
	if (mode === 'am') {
		try {
			await journal.trackHead(root, `Apply ${name} as commits`, () =>
				git.run(['am', '-3', '--keep-cr'], { cwd: root, input: text, env: rw.editorEnv() }),
			);
		} catch (e) {
			const state = await git.sequencerState(root);
			if (state && onSequencer) return onSequencer(root, new rw.RewriteError(rw.firstLines(e.stderr || e.message), { state }));
			throw e;
		}
		vscode.window.setStatusBarMessage(`$(check) Applied ${name} as commits`, 3000);
		return true;
	}
	try {
		await git.run(['apply', '--whitespace=nowarn', '-'], { cwd: root, input: text });
	} catch (e) {
		const why = rw.firstLines(e.stderr || e.message, 3);
		const retry = await vscode.window.showWarningMessage(
			`Revwise: the patch doesn't apply cleanly.\n${why}`,
			{ modal: true, detail: 'A 3-way merge applies what it can and leaves conflict markers for the rest.' },
			'Try 3-Way Merge',
		);
		if (retry !== 'Try 3-Way Merge') return false;
		await git.run(['apply', '--3way', '--whitespace=nowarn', '-'], { cwd: root, input: text, okCodes: [1] });
		vscode.window.showWarningMessage('Revwise: patch applied with a 3-way merge. Check for conflict markers before committing.');
	}
	if (Buffer.byteLength(text) <= MAX_JOURNALED_PATCH) await journal.record(root, `Apply ${name}`, 'patchApplied', { patch: text });
	vscode.window.setStatusBarMessage(`$(check) Applied ${name}`, 3000);
	return true;
}

module.exports = { showPatch, readPatchInput, applyPatch };
