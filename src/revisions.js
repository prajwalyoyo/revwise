'use strict';
const vscode = require('vscode');
const path = require('path');
const git = require('./git');
const { gitUri, parse } = require('./uris');
const { shortSha } = require('./format');

/**
 * Step through a file's history as consecutive diffs.
 * Position -1 is the working file; position k is the k-th newest commit touching the file (`git log --follow`).
 * Diff shown for position k: (k+1) ↔ k.
 */
class RevisionNavigator {
	constructor(repos) {
		this.repos = repos;
		this.cache = new Map();
		this.disposables = [
			repos.onDidChangeRepo(() => this.cache.clear()),
			vscode.workspace.onDidSaveTextDocument(() => this.cache.clear()),
		];
	}

	dispose() {
		for (const d of this.disposables) d.dispose();
	}

	async _context() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return undefined;
		const uri = editor.document.uri;
		let fsPath;
		let ref;
		if (uri.scheme === 'file') fsPath = uri.fsPath;
		else {
			const q = parse(uri);
			if (!q?.fsPath || !q.ref) return undefined;
			fsPath = q.fsPath;
			ref = q.ref;
		}
		const root = await this.repos.resolve(fsPath);
		if (!root) return undefined;
		const key = `${root}|${fsPath}`;
		let entries = this.cache.get(key);
		if (!entries) {
			entries = await git.fileLog(root, fsPath, 1000);
			this.cache.set(key, entries);
		}
		let pos = -1;
		if (ref) {
			pos = entries.findIndex(e => e.sha === ref || e.sha.startsWith(ref));
			if (pos === -1) pos = 0;
		}
		return { root, fsPath, entries, pos, line: editor.selection.active.line };
	}

	async _open(ctx, pos) {
		const { root, fsPath, entries } = ctx;
		if (pos < -1) return;
		if (pos >= entries.length) {
			vscode.window.setStatusBarMessage('Revwise: no older revisions', 2500);
			return;
		}
		const name = path.basename(fsPath);
		let right;
		let rightLabel;
		if (pos === -1) {
			right = vscode.Uri.file(fsPath);
			rightLabel = 'Working Tree';
		} else {
			right = gitUri(root, entries[pos].sha, entries[pos].filename, fsPath);
			rightLabel = shortSha(entries[pos].sha);
		}
		const leftEntry = entries[pos + 1];
		const leftSha = leftEntry ? leftEntry.sha : pos >= 0 ? `${entries[pos].sha}^` : 'HEAD';
		const leftPath = leftEntry ? leftEntry.filename : pos >= 0 ? entries[pos].filename : git.toGitPath(root, fsPath);
		const left = gitUri(root, leftSha, leftPath, fsPath);
		const leftLabel = leftEntry ? shortSha(leftEntry.sha) : pos >= 0 ? `${shortSha(entries[pos].sha)}^` : 'HEAD';
		await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${leftLabel}) ↔ (${rightLabel})`, {
			preview: true,
			selection: new vscode.Range(ctx.line, 0, ctx.line, 0),
		});
	}

	async previous() {
		const ctx = await this._context();
		if (!ctx) return;
		// From the working file with no uncommitted changes, (HEAD ↔ working) would be empty; start at the last commit.
		let target = ctx.pos + 1;
		if (ctx.pos === -1) {
			const doc = vscode.window.activeTextEditor.document;
			const dirty = doc.isDirty || (await git.diffFiles(ctx.root, 'HEAD').catch(() => [])).some(
				f => path.join(ctx.root, f.path).toLowerCase() === ctx.fsPath.toLowerCase(),
			);
			target = dirty ? -1 : 0;
		}
		return this._open(ctx, target);
	}

	async next() {
		const ctx = await this._context();
		if (!ctx) return;
		if (ctx.pos === -1) {
			vscode.window.setStatusBarMessage('Revwise: already at the working file', 2500);
			return;
		}
		return this._open(ctx, ctx.pos - 1);
	}

	async openWorkingFile() {
		const editor = vscode.window.activeTextEditor;
		const q = parse(editor?.document.uri);
		if (!q?.fsPath) return;
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(q.fsPath));
		const line = editor.selection.active.line;
		await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
	}

	async openRevision(arg) {
		const ctx = await this._context();
		if (!ctx || !ctx.entries.length) return;
		const pick = arg?.sha
			? ctx.entries.find(e => e.sha === arg.sha)
			: (
					await vscode.window.showQuickPick(
						ctx.entries.map(e => ({ label: e.summary, description: `${e.author} • ${shortSha(e.sha)}`, entry: e })),
						{ title: `Open Revision: ${path.basename(ctx.fsPath)}`, matchOnDescription: true },
					)
				)?.entry;
		if (!pick) return;
		const doc = await vscode.workspace.openTextDocument(gitUri(ctx.root, pick.sha, pick.filename, ctx.fsPath));
		await vscode.window.showTextDocument(doc, { preview: true });
	}
}

module.exports = { RevisionNavigator };
