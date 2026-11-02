'use strict';
const vscode = require('vscode');
const path = require('path');
const git = require('./git');
const { gitUri } = require('./uris');

const DEFAULT_ID = 'default';
const MIME = 'application/vnd.code.tree.revwise.changelists';
const STATUS = {
	M: ['diff-modified', 'Modified', 'gitDecoration.modifiedResourceForeground'],
	A: ['diff-added', 'Added', 'gitDecoration.addedResourceForeground'],
	D: ['diff-removed', 'Deleted', 'gitDecoration.deletedResourceForeground'],
	R: ['diff-renamed', 'Renamed', 'gitDecoration.renamedResourceForeground'],
	C: ['diff-added', 'Copied', 'gitDecoration.addedResourceForeground'],
	T: ['diff-modified', 'Type changed', 'gitDecoration.modifiedResourceForeground'],
	'?': ['diff-added', 'Untracked', 'gitDecoration.untrackedResourceForeground'],
	'!': ['warning', 'Conflicted', 'gitDecoration.conflictingResourceForeground'],
};

/**
 * JetBrains-style changelists: named groups of uncommitted files, stored per repository in workspace state.
 * New changed files land in the active changelist. Each list can be committed, stashed or exported as a patch
 * on its own, independent of the git index.
 */
class ChangelistsView {
	constructor(context, repos, journal) {
		this.context = context;
		this.repos = repos;
		this.journal = journal;
		this.files = [];
		this.root = undefined;
		this._em = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._em.event;
		this.view = vscode.window.createTreeView('revwise.changelists', {
			treeDataProvider: this,
			dragAndDropController: this,
			canSelectMany: true,
			showCollapseAll: true,
		});
		this.dragMimeTypes = [MIME];
		this.dropMimeTypes = [MIME, 'text/uri-list'];
		let timer;
		this.schedule = () => {
			clearTimeout(timer);
			timer = setTimeout(() => this.reload(), 300);
		};
		this.disposables = [
			this._em,
			this.view,
			repos.onDidChangeActive(() => this.reload()),
			repos.onDidChangeRepo(() => this.schedule()),
			vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
			vscode.workspace.onDidCreateFiles(() => this.schedule()),
			vscode.workspace.onDidDeleteFiles(() => this.schedule()),
			vscode.workspace.onDidRenameFiles(() => this.schedule()),
			vscode.window.onDidChangeWindowState(s => s.focused && this.schedule()),
			this.view.onDidChangeVisibility(() => this.view.visible && this.schedule()),
		];
		this._hookBuiltInGit();
		this.reload();
	}

	dispose() {
		for (const d of this.disposables) d.dispose();
	}

	/** The built-in Git extension already watches the working tree; reuse its change events when available. */
	_hookBuiltInGit() {
		try {
			const ext = vscode.extensions.getExtension('vscode.git');
			if (!ext?.isActive) return;
			const api = ext.exports.getAPI(1);
			const hook = r => this.disposables.push(r.state.onDidChange(() => this.schedule()));
			api.repositories.forEach(hook);
			this.disposables.push(api.onDidOpenRepository(hook));
		} catch {}
	}

	// ----- state -----

	_key(root) {
		return `revwise.changelists:${root.toLowerCase()}`;
	}

	_state(root = this.root) {
		const s = this.context.workspaceState.get(this._key(root));
		return s ? JSON.parse(JSON.stringify(s)) : { lists: [{ id: DEFAULT_ID, name: 'Changes' }], active: DEFAULT_ID, files: {} };
	}

	async _save(state, root = this.root) {
		await this.context.workspaceState.update(this._key(root), state);
		this._em.fire();
	}

	lists() {
		return this._state().lists;
	}

	async reload() {
		await this.repos.ready;
		const root = this.repos.active;
		this.root = root;
		if (!root) {
			this.files = [];
			this._em.fire();
			return;
		}
		try {
			this.files = await git.status(root);
		} catch {
			this.files = [];
		}
		if (root !== this.root) return;
		// Assign newly changed files to the active list and forget files that are no longer changed.
		const state = this._state();
		const valid = new Set(state.lists.map(l => l.id));
		const present = new Set(this.files.map(f => f.path));
		let dirty = false;
		for (const f of this.files) {
			if (!state.files[f.path] || !valid.has(state.files[f.path])) {
				state.files[f.path] = valid.has(state.active) ? state.active : DEFAULT_ID;
				dirty = true;
			}
		}
		for (const p of Object.keys(state.files)) {
			if (!present.has(p)) {
				delete state.files[p];
				dirty = true;
			}
		}
		if (dirty) await this.context.workspaceState.update(this._key(root), state);
		const n = this.files.length;
		this.view.badge = n ? { value: n, tooltip: `${n} changed file${n === 1 ? '' : 's'}` } : undefined;
		this.view.description = path.basename(root);
		this._em.fire();
	}

	filesIn(listId) {
		const state = this._state();
		return this.files.filter(f => (state.files[f.path] || DEFAULT_ID) === listId);
	}

	// ----- tree -----

	getTreeItem(node) {
		if (node.kind === 'list') {
			const state = this._state();
			const count = this.filesIn(node.id).length;
			const active = state.active === node.id;
			const item = new vscode.TreeItem(node.name, count ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
			item.id = `cl|${this.root}|${node.id}`;
			item.description = `${count} file${count === 1 ? '' : 's'}${active ? ' • active' : ''}`;
			item.tooltip = `${node.name}${active ? '\nActive: new changes go here' : ''}`;
			item.iconPath = new vscode.ThemeIcon(active ? 'pass-filled' : 'circle-large-outline');
			item.contextValue = node.id === DEFAULT_ID ? 'changelist.default' : 'changelist';
			return item;
		}
		if (node.kind === 'message') {
			const item = new vscode.TreeItem(node.text);
			item.iconPath = new vscode.ThemeIcon('info');
			return item;
		}
		const f = node.file;
		const [icon, label, color] = STATUS[f.status] || ['file', f.status, undefined];
		const item = new vscode.TreeItem(path.basename(f.path));
		item.id = `clf|${this.root}|${f.path}`;
		const dir = path.dirname(f.path);
		item.description = (dir === '.' ? '' : dir) + (f.origPath ? `  ← ${f.origPath}` : '');
		item.tooltip = `${label}: ${f.path}`;
		item.iconPath = new vscode.ThemeIcon(icon, color && new vscode.ThemeColor(color));
		item.resourceUri = vscode.Uri.file(path.join(this.root, f.path));
		item.contextValue = 'changelistFile';
		item.command = { title: 'Open Changes', command: 'revwise.changelists.openChanges', arguments: [node] };
		return item;
	}

	getChildren(node) {
		if (!this.root) return [{ kind: 'message', text: 'No git repository found' }];
		if (!node) return this._state().lists.map(l => ({ kind: 'list', ...l }));
		if (node.kind !== 'list') return [];
		return this.filesIn(node.id).map(file => ({ kind: 'file', file, listId: node.id, path: file.path }));
	}

	getParent(node) {
		if (node.kind === 'file') {
			const l = this._state().lists.find(x => x.id === node.listId);
			return l && { kind: 'list', ...l };
		}
		return undefined;
	}

	// ----- drag & drop -----

	handleDrag(source, dataTransfer) {
		const paths = source.filter(n => n.kind === 'file').map(n => n.path);
		if (paths.length) dataTransfer.set(MIME, new vscode.DataTransferItem(paths));
	}

	async handleDrop(target, dataTransfer) {
		if (!this.root) return;
		const listId = !target ? DEFAULT_ID : target.kind === 'list' ? target.id : target.listId;
		let paths = dataTransfer.get(MIME)?.value;
		if (!paths) {
			const uris = await dataTransfer.get('text/uri-list')?.asString();
			if (!uris) return;
			paths = uris
				.split(/\r?\n/)
				.filter(Boolean)
				.map(u => git.toGitPath(this.root, vscode.Uri.parse(u).fsPath));
		}
		await this.move(paths, listId);
	}

	// ----- operations -----

	async move(paths, listId) {
		const state = this._state();
		const changed = new Set(this.files.map(f => f.path));
		for (const p of paths) if (changed.has(p)) state.files[p] = listId;
		await this._save(state);
	}

	async create(name) {
		const state = this._state();
		const id = `cl-${Date.now().toString(36)}`;
		state.lists.push({ id, name });
		await this._save(state);
		return id;
	}

	async rename(id, name) {
		const state = this._state();
		const l = state.lists.find(x => x.id === id);
		if (l) l.name = name;
		await this._save(state);
	}

	async remove(id) {
		if (id === DEFAULT_ID) return;
		const state = this._state();
		state.lists = state.lists.filter(l => l.id !== id);
		for (const [p, l] of Object.entries(state.files)) if (l === id) state.files[p] = DEFAULT_ID;
		if (state.active === id) state.active = DEFAULT_ID;
		await this._save(state);
	}

	async setActive(id) {
		const state = this._state();
		state.active = id;
		await this._save(state);
	}

	/** All paths git needs for these files (both sides of a rename). */
	_paths(files) {
		const out = [];
		for (const f of files) {
			out.push(f.path);
			if (f.origPath) out.push(f.origPath);
		}
		return out;
	}

	async commit(listId, message) {
		const root = this.root;
		const files = this.filesIn(listId);
		if (!files.length) throw new Error('This changelist has no changes.');
		if (files.some(f => f.status === '!')) throw new Error('Resolve the conflicted files in this changelist first.');
		const untracked = files.filter(f => f.status === '?').map(f => f.path);
		const list = this._state().lists.find(l => l.id === listId);
		await this.journal.trackHead(
			root,
			`Commit changelist "${list?.name}"`,
			async () => {
				if (untracked.length) await git.run(['add', '--', ...untracked], { cwd: root });
				// --only commits exactly these paths' working-tree content, leaving anything else staged untouched.
				await git.run(['commit', '--only', '-F', '-', '--', ...this._paths(files)], { cwd: root, input: message });
			},
			{ mode: 'mixed' },
		);
		await this.reload();
	}

	async stash(listId) {
		const root = this.root;
		const files = this.filesIn(listId);
		if (!files.length) throw new Error('This changelist has no changes.');
		const list = this._state().lists.find(l => l.id === listId);
		await git.run(['stash', 'push', '--include-untracked', '-m', list?.name || 'changelist', '--', ...this._paths(files)], { cwd: root });
		await this.reload();
	}

	patch(listId) {
		return git.workingPatch(this.root, this._paths(this.filesIn(listId)));
	}

	async openChanges(node) {
		const f = node.file;
		const fsPath = path.join(this.root, f.path);
		const name = path.basename(f.path);
		if (f.status === '?') return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fsPath));
		const left = gitUri(this.root, 'HEAD', f.origPath || f.path, fsPath);
		if (f.status === 'D') return vscode.commands.executeCommand('vscode.open', left);
		return vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(fsPath), `${name} (HEAD) ↔ (Working Tree)`);
	}
}

function registerChangelistCommands(context, view, { showPatch }) {
	const reg = (id, fn) =>
		context.subscriptions.push(
			vscode.commands.registerCommand(id, async (...a) => {
				try {
					return await fn(...a);
				} catch (e) {
					vscode.window.showErrorMessage(`Revwise: ${String(e.stderr || e.message || e).trim()}`);
				}
			}),
		);
	const listOf = node => (node?.kind === 'list' ? node : undefined);
	const pickList = async (title, { allowNew = true } = {}) => {
		const items = view.lists().map(l => ({ label: l.name, id: l.id }));
		if (allowNew) items.push({ label: '$(add) New Changelist…', id: '__new' });
		const pick = await vscode.window.showQuickPick(items, { title });
		if (!pick) return undefined;
		if (pick.id !== '__new') return pick.id;
		const name = await vscode.window.showInputBox({ title: 'New changelist', prompt: 'Name' });
		return name ? view.create(name) : undefined;
	};
	const resolveList = async (node, title) => listOf(node)?.id ?? (await pickList(title, { allowNew: false }));

	reg('revwise.changelists.refresh', () => view.reload());
	reg('revwise.changelists.new', async () => {
		const name = await vscode.window.showInputBox({ title: 'New changelist', prompt: 'Name' });
		if (!name) return;
		const id = await view.create(name);
		const make = await vscode.window.showQuickPick(['Yes', 'No'], { title: `Make "${name}" the active changelist?` });
		if (make === 'Yes') await view.setActive(id);
	});
	reg('revwise.changelists.rename', async node => {
		const l = listOf(node);
		if (!l) return;
		const name = await vscode.window.showInputBox({ title: 'Rename changelist', value: l.name });
		if (name) await view.rename(l.id, name);
	});
	reg('revwise.changelists.delete', async node => {
		const l = listOf(node);
		if (!l || l.id === DEFAULT_ID) return;
		const ok = await vscode.window.showWarningMessage(
			`Delete changelist "${l.name}"? Its files move to "Changes"; no changes are lost.`,
			{ modal: true },
			'Delete',
		);
		if (ok === 'Delete') await view.remove(l.id);
	});
	reg('revwise.changelists.setActive', async node => {
		const id = await resolveList(node, 'Set active changelist');
		if (id) await view.setActive(id);
	});
	reg('revwise.changelists.commit', async node => {
		const id = listOf(node)?.id ?? view._state().active;
		const list = view.lists().find(l => l.id === id);
		const count = view.filesIn(id).length;
		if (!count) return vscode.window.showInformationMessage(`Revwise: "${list.name}" has no changes to commit.`);
		const message = await vscode.window.showInputBox({
			title: `Commit ${count} file${count === 1 ? '' : 's'} from "${list.name}"`,
			prompt: 'Commit message',
			value: list.id === DEFAULT_ID ? '' : list.name,
			validateInput: v => (v.trim() ? undefined : 'Enter a commit message'),
		});
		if (!message) return;
		await view.commit(id, message);
		vscode.window.setStatusBarMessage(`$(check) Committed "${list.name}"`, 3000);
	});
	reg('revwise.changelists.stash', async node => {
		const id = await resolveList(node, 'Stash changelist');
		if (!id) return;
		await view.stash(id);
		vscode.window.setStatusBarMessage('$(check) Stashed changelist', 3000);
	});
	reg('revwise.changelists.createPatch', async node => {
		const id = await resolveList(node, 'Create patch from changelist');
		if (!id) return;
		const list = view.lists().find(l => l.id === id);
		await showPatch(await view.patch(id), `${list.name.replace(/[^\w.-]+/g, '-')}.patch`);
	});
	reg('revwise.changelists.openChanges', node => node?.file && view.openChanges(node));
	reg('revwise.changelists.moveTo', async (node, all) => {
		let paths;
		if (node instanceof vscode.Uri) {
			const sel = Array.isArray(all) && all.length ? all : [node];
			paths = sel.map(u => git.toGitPath(view.root, u.fsPath));
		} else if (node?.kind === 'file') {
			paths = (all?.length ? all : [node]).filter(n => n.kind === 'file').map(n => n.path);
		} else {
			const uri = vscode.window.activeTextEditor?.document.uri;
			if (!uri || uri.scheme !== 'file' || !view.root) return;
			paths = [git.toGitPath(view.root, uri.fsPath)];
		}
		const id = await pickList(`Move ${paths.length} file${paths.length === 1 ? '' : 's'} to changelist`);
		if (id) await view.move(paths, id);
	});
}

module.exports = { ChangelistsView, registerChangelistCommands, DEFAULT_ID };
