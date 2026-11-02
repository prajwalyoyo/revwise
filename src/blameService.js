'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const git = require('./git');

/**
 * Per-document blame cache keyed by URI + document version.
 * Saved documents are blamed from disk; dirty documents are blamed with `--contents -`
 * so line numbers always match the editor buffer.
 */
class BlameService {
	constructor(repos) {
		this.repos = repos;
		this._cache = new Map();
		this._onDidChange = new vscode.EventEmitter();
		this.onDidChange = this._onDidChange.event;
		this._disposables = [
			this._onDidChange,
			vscode.workspace.onDidSaveTextDocument(d => this.invalidate(d.uri)),
			vscode.workspace.onDidCloseTextDocument(d => this._cache.delete(d.uri.toString())),
			// Catches commits/checkouts done outside VS Code that the watcher may miss.
			vscode.window.onDidChangeWindowState(s => s.focused && this.invalidateAll()),
			repos.onDidChangeRepo(root => this.invalidateAll(root)),
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('revwise.blame') && this.invalidateAll()),
			vscode.workspace.onDidSaveTextDocument(d => /\.git-blame-ignore-revs$/.test(d.fileName) && this.invalidateAll()),
		];
	}

	dispose() {
		for (const d of this._disposables) d.dispose();
		this._cache.clear();
	}

	invalidate(uri) {
		if (this._cache.delete(uri.toString())) this._onDidChange.fire(uri);
	}

	invalidateAll(root) {
		if (root == null) git.clearRootCache();
		for (const [key, entry] of this._cache) {
			if (root == null || entry.root === root) this._cache.delete(key);
		}
		this._onDidChange.fire(undefined);
	}

	/** Returns { root, blame } or undefined when the document isn't tracked by git. */
	get(document) {
		if (document.uri.scheme !== 'file' || document.isUntitled) return Promise.resolve(undefined);
		const key = document.uri.toString();
		const cached = this._cache.get(key);
		if (cached && cached.version === document.version) return cached.promise;
		cached?.abort.abort();

		const abort = new AbortController();
		const entry = { version: document.version, abort, root: undefined, promise: undefined };
		entry.promise = this._compute(document, abort.signal, entry).catch(() => undefined);
		this._cache.set(key, entry);
		return entry.promise;
	}

	async _compute(document, signal, entry) {
		const fsPath = document.uri.fsPath;
		const root = await this.repos.resolve(fsPath);
		if (!root) return undefined;
		entry.root = root;
		const c = vscode.workspace.getConfiguration('revwise.blame');
		const ignoreName = c.get('ignoreRevsFile', '.git-blame-ignore-revs');
		const ignorePath = ignoreName ? path.resolve(root, ignoreName) : undefined;
		const blame = await git.blame(root, fsPath, {
			contents: document.isDirty ? document.getText() : undefined,
			signal,
			detectMoves: c.get('detectMoves', 'file'),
			ignoreWhitespace: c.get('ignoreWhitespace', false),
			ignoreRevsFile: ignorePath && fs.existsSync(ignorePath) ? ignorePath : undefined,
		});
		return { root, blame };
	}
}

module.exports = { BlameService };
