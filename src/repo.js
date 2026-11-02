'use strict';
const vscode = require('vscode');
const path = require('path');
const git = require('./git');

/**
 * Discovers repositories (workspace folders + opened files), tracks the "active" one
 * (repo of the active editor, falling back to the first discovered), and watches each
 * git dir so views/blame refresh after commits, checkouts, fetches and stash changes.
 */
class RepoManager {
	constructor() {
		this.roots = new Map();
		this.active = undefined;
		this._onDidChangeRepo = new vscode.EventEmitter();
		this.onDidChangeRepo = this._onDidChangeRepo.event;
		this._onDidChangeActive = new vscode.EventEmitter();
		this.onDidChangeActive = this._onDidChangeActive.event;
		this._onDidChangeRoots = new vscode.EventEmitter();
		this.onDidChangeRoots = this._onDidChangeRoots.event;
		this._disposables = [
			this._onDidChangeRepo,
			this._onDidChangeActive,
			this._onDidChangeRoots,
			vscode.window.onDidChangeActiveTextEditor(e => this._trackEditor(e)),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.discover()),
		];
		this.ready = this.discover().then(() => this._trackEditor(vscode.window.activeTextEditor));
	}

	dispose() {
		for (const d of this._disposables) d.dispose();
		for (const r of this.roots.values()) r.watcher?.dispose();
		this.roots.clear();
	}

	async discover() {
		const folders = vscode.workspace.workspaceFolders || [];
		await Promise.all(folders.filter(f => f.uri.scheme === 'file').map(f => this.resolve(f.uri.fsPath, true)));
		if (!this.active && this.roots.size) this.setActive(this.roots.keys().next().value);
	}

	/** Returns the repo root for a path (file or directory), registering it if new. */
	async resolve(fsPath, isDir = false) {
		const root = await git.getRepoRoot(isDir ? fsPath : path.dirname(fsPath));
		if (root) await this.add(root);
		return root;
	}

	async add(root) {
		if (this.roots.has(root)) return;
		const entry = { root, watcher: undefined };
		this.roots.set(root, entry);
		try {
			const dir = await git.gitDir(root);
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(dir), '{HEAD,index,packed-refs,FETCH_HEAD,refs/**}'),
			);
			let timer;
			const fire = () => {
				clearTimeout(timer);
				timer = setTimeout(() => this._onDidChangeRepo.fire(root), 300);
			};
			watcher.onDidChange(fire);
			watcher.onDidCreate(fire);
			watcher.onDidDelete(fire);
			entry.watcher = watcher;
		} catch {
			// Not fatal: views still refresh on window focus / manual refresh.
		}
		this._onDidChangeRoots.fire();
		if (!this.active) this.setActive(root);
	}

	setActive(root) {
		if (!root || root === this.active) return;
		this.active = root;
		vscode.commands.executeCommand('setContext', 'revwise.hasRepo', true);
		this._onDidChangeActive.fire(root);
	}

	async _trackEditor(editor) {
		const uri = editor?.document.uri;
		if (!uri) return;
		let fsPath;
		if (uri.scheme === 'file') fsPath = uri.fsPath;
		else if (uri.scheme === 'revwise') {
			try {
				const q = JSON.parse(uri.query);
				if (q.root) return this.setActive(q.root);
			} catch {}
			return;
		} else return;
		const root = await this.resolve(fsPath);
		if (root) this.setActive(root);
	}

	/** Active root, or asks the user when several repos are open and none is active. */
	async pick() {
		await this.ready;
		if (this.active) return this.active;
		if (!this.roots.size) {
			vscode.window.showInformationMessage('Revwise: no git repository found in this workspace.');
			return undefined;
		}
		const pick = await vscode.window.showQuickPick([...this.roots.keys()], { title: 'Select a repository' });
		if (pick) this.setActive(pick);
		return pick;
	}

	refresh(root) {
		this._onDidChangeRepo.fire(root);
	}
}

module.exports = { RepoManager };
