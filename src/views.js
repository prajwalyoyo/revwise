'use strict';
const vscode = require('vscode');
const path = require('path');
const git = require('./git');
const { fromNow, shortSha } = require('./format');
const { diffFile } = require('./uris');

const PAGE = 50;
const cfg = () => vscode.workspace.getConfiguration('revwise');

// ---------- nodes ----------

function commitTooltip(c) {
	const md = new vscode.MarkdownString(undefined, true);
	md.appendMarkdown(`$(account) **${c.author}** ${c.email ? `\\<${c.email}\\>` : ''}\n\n`);
	md.appendMarkdown(`$(history) ${fromNow(c.date)} (${c.date.toLocaleString()})\n\n`);
	md.appendText(c.summary || '');
	md.appendMarkdown(`\n\n$(git-commit) \`${c.sha}\``);
	const refs = (c.refs || []).filter(r => r.type !== 'head').map(r => r.name);
	if (refs.length) md.appendMarkdown(`\n\n$(tag) ${refs.join(', ')}`);
	return md;
}

class MessageNode {
	constructor(text, icon = 'info') {
		this.text = text;
		this.icon = icon;
	}
	toItem() {
		const item = new vscode.TreeItem(this.text, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon(this.icon);
		item.contextValue = 'message';
		return item;
	}
}

class LoadMoreNode {
	constructor(provider, owner, source) {
		this.provider = provider;
		this.owner = owner;
		this.source = source;
	}
	toItem() {
		const item = new vscode.TreeItem('Load more…', vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('ellipsis');
		item.contextValue = 'loadMore';
		item.command = { title: 'Load more', command: 'revwise.views.loadMore', arguments: [this] };
		return item;
	}
	loadMore() {
		this.source.limit += PAGE;
		this.provider.refresh(this.owner);
	}
}

/** A paged commit list defined by `git log` arguments. */
class CommitSource {
	constructor(root, args, { file } = {}) {
		this.root = root;
		this.args = args;
		this.limit = PAGE;
		this.file = file;
	}
	async nodes(provider, owner) {
		const commits = await git.log(this.root, [`-n${this.limit + 1}`, ...this.args]);
		const more = commits.length > this.limit;
		const nodes = commits.slice(0, this.limit).map(c => new CommitNode(this.root, c, { file: this.file }));
		if (more) nodes.push(new LoadMoreNode(provider, owner, this));
		return nodes;
	}
}

class CommitNode {
	/** `file` = { fsPath } when the commit is shown in the context of a single file (file/line history). */
	constructor(root, commit, { file, filename, parentRef } = {}) {
		this.root = root;
		this.commit = commit;
		this.sha = commit.sha;
		this.summary = commit.summary;
		this.file = file;
		this.filename = filename;
		this.parentRef = parentRef;
	}
	toItem() {
		const c = this.commit;
		const leaf = !!this.file;
		const item = new vscode.TreeItem(
			c.summary || shortSha(c.sha),
			leaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = `${c.author}, ${fromNow(c.date)}`;
		item.tooltip = commitTooltip(c);
		item.iconPath = new vscode.ThemeIcon(c.parents.length > 1 ? 'git-merge' : 'git-commit');
		item.contextValue = 'commit';
		if (leaf) {
			const fsPath = this.file.fsPath;
			const rel = this.filename || git.toGitPath(this.root, fsPath);
			item.command = {
				title: 'Open Changes',
				command: 'revwise.views.diffCommitFile',
				arguments: [{ root: this.root, sha: c.sha, parent: c.parents[0], path: rel }],
			};
		}
		return item;
	}
	async children() {
		const files = await git.commitFiles(this.root, this.sha);
		const parent = this.commit.parents[0] ?? `${this.sha}^`;
		return files.map(f => new FileNode(this.root, f, parent, this.sha));
	}
}

const STATUS = {
	A: ['diff-added', 'Added', 'gitDecoration.addedResourceForeground'],
	M: ['diff-modified', 'Modified', 'gitDecoration.modifiedResourceForeground'],
	D: ['diff-removed', 'Deleted', 'gitDecoration.deletedResourceForeground'],
	R: ['diff-renamed', 'Renamed', 'gitDecoration.renamedResourceForeground'],
	C: ['diff-added', 'Copied', 'gitDecoration.addedResourceForeground'],
	T: ['diff-modified', 'Type changed', 'gitDecoration.modifiedResourceForeground'],
};

class FileNode {
	/** Diff of `file` between `left` ref and `right` ref (undefined right = working tree). */
	constructor(root, file, left, right) {
		this.root = root;
		this.file = file;
		this.left = left;
		this.right = right;
		this.sha = right;
		this.fsPath = path.join(root, file.path);
	}
	toItem() {
		const f = this.file;
		const item = new vscode.TreeItem(path.basename(f.path), vscode.TreeItemCollapsibleState.None);
		const dir = path.dirname(f.path);
		const [icon, label, color] = STATUS[f.status] || ['file', f.status, undefined];
		item.description = `${dir === '.' ? '' : dir}${f.originalPath ? `  ← ${f.originalPath}` : ''}`;
		item.tooltip = `${label}: ${f.path}${f.originalPath ? `\nfrom ${f.originalPath}` : ''}`;
		item.iconPath = new vscode.ThemeIcon(icon, color && new vscode.ThemeColor(color));
		item.resourceUri = vscode.Uri.file(this.fsPath);
		item.contextValue = 'file';
		item.command = { title: 'Open Changes', command: 'revwise.views.openFileChanges', arguments: [this] };
		return item;
	}
	openChanges() {
		const f = this.file;
		const leftPath = f.status === 'A' ? f.path : f.originalPath || f.path;
		return diffFile(this.root, this.left, leftPath, this.right, f.path);
	}
}

class BranchNode {
	constructor(root, branch) {
		this.root = root;
		this.branch = branch;
		this.sha = branch.sha;
		this.refName = branch.name;
		this.source = new CommitSource(root, [branch.name, '--']);
	}
	toItem() {
		const b = this.branch;
		const label = b.remote ? b.name.slice(b.remoteName.length + 1) : b.name;
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
		item.id = `branch|${this.root}|${b.name}`;
		const parts = [];
		if (b.ahead) parts.push(`${b.ahead}↑`);
		if (b.behind) parts.push(`${b.behind}↓`);
		if (b.upstream) parts.push(b.gone ? `${b.upstream} (gone)` : b.upstream);
		parts.push(fromNow(b.date));
		item.description = parts.join('  ');
		item.tooltip = `${b.name}${b.current ? ' (current)' : ''}\n${b.upstream ? `Tracking ${b.upstream}\n` : ''}${b.subject}\n${shortSha(b.sha)} • ${b.date.toLocaleString()}`;
		item.iconPath = new vscode.ThemeIcon(b.current ? 'check' : b.remote ? 'cloud' : 'git-branch');
		item.contextValue = b.remote ? 'remoteBranch' : b.current ? 'branch.current' : 'branch';
		return item;
	}
	children(provider) {
		return this.source.nodes(provider, this);
	}
}

class RemoteNode {
	constructor(root, remote) {
		this.root = root;
		this.remote = remote;
	}
	toItem() {
		const item = new vscode.TreeItem(this.remote.name, vscode.TreeItemCollapsibleState.Collapsed);
		item.id = `remote|${this.root}|${this.remote.name}`;
		item.description = this.remote.url;
		item.iconPath = new vscode.ThemeIcon('cloud');
		item.contextValue = 'remote';
		return item;
	}
	async children() {
		const all = await git.branches(this.root);
		const list = all.filter(b => b.remote && b.remoteName === this.remote.name);
		return list.length ? list.map(b => new BranchNode(this.root, b)) : [new MessageNode('No remote branches')];
	}
}

class TagNode {
	constructor(root, tag) {
		this.root = root;
		this.tag = tag;
		this.sha = tag.sha;
		this.refName = tag.name;
		this.source = new CommitSource(root, [tag.name, '--']);
	}
	toItem() {
		const t = this.tag;
		const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.Collapsed);
		item.id = `tag|${this.root}|${t.name}`;
		item.description = `${shortSha(t.sha)}  ${fromNow(t.date)}`;
		item.tooltip = `${t.name}${t.annotated ? ' (annotated)' : ''}\n${t.subject}\n${t.date.toLocaleString()}`;
		item.iconPath = new vscode.ThemeIcon('tag');
		item.contextValue = 'tag';
		return item;
	}
	children(provider) {
		return this.source.nodes(provider, this);
	}
}

class StashNode {
	constructor(root, stash) {
		this.root = root;
		this.stash = stash;
		this.sha = stash.sha;
		this.refName = stash.ref;
	}
	toItem() {
		const s = this.stash;
		const item = new vscode.TreeItem(s.message, vscode.TreeItemCollapsibleState.Collapsed);
		item.id = `stash|${this.root}|${s.sha}`;
		item.description = `${s.ref}${s.branch ? ` on ${s.branch}` : ''}  ${fromNow(s.date)}`;
		item.tooltip = `${s.ref}\n${s.message}\n${s.date.toLocaleString()}`;
		item.iconPath = new vscode.ThemeIcon('archive');
		item.contextValue = 'stash';
		return item;
	}
	async children() {
		const files = await git.stashFiles(this.root, this.stash.ref);
		return files.map(f => new FileNode(this.root, f, `${this.stash.sha}^`, this.stash.sha));
	}
}

class WorktreeNode {
	constructor(root, wt) {
		this.root = root;
		this.worktree = wt;
		this.sha = wt.sha;
	}
	toItem() {
		const w = this.worktree;
		const current = path.normalize(w.path).toLowerCase() === path.normalize(this.root).toLowerCase();
		const item = new vscode.TreeItem(w.branch || (w.bare ? '(bare)' : `(detached ${shortSha(w.sha || '')})`));
		item.description = w.path + (w.locked ? '  🔒' : '') + (w.prunable ? '  (prunable)' : '');
		item.tooltip = `${w.path}\n${w.sha || ''}`;
		item.iconPath = new vscode.ThemeIcon(current ? 'check' : 'list-tree');
		item.contextValue = current ? 'worktree.current' : 'worktree';
		return item;
	}
}

class ContributorNode {
	constructor(root, contributor, total) {
		this.root = root;
		this.contributor = contributor;
		this.total = total;
		this.source = new CommitSource(root, ['--no-merges', `--author=${contributor.email || contributor.name}`, 'HEAD', '--']);
	}
	toItem() {
		const c = this.contributor;
		const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.Collapsed);
		item.id = `contrib|${this.root}|${c.email}|${c.name}`;
		const pct = this.total ? Math.round((c.count / this.total) * 100) : 0;
		item.description = `${c.count} commit${c.count === 1 ? '' : 's'} (${pct}%)  ${c.email}`;
		item.iconPath = new vscode.ThemeIcon('account');
		item.contextValue = 'contributor';
		return item;
	}
	children(provider) {
		return this.source.nodes(provider, this);
	}
}

class GroupNode {
	constructor(label, icon, loader, { description, contextValue = 'group', expanded = true } = {}) {
		this.label = label;
		this.icon = icon;
		this.loader = loader;
		this.description = description;
		this.contextValue = contextValue;
		this.expanded = expanded;
	}
	toItem() {
		const item = new vscode.TreeItem(
			this.label,
			this.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.iconPath = new vscode.ThemeIcon(this.icon);
		item.description = this.description;
		item.contextValue = this.contextValue;
		return item;
	}
	children(provider) {
		return this.loader(provider, this);
	}
}

// ---------- providers ----------

class BaseView {
	constructor(id, repos, { showCollapseAll = true, canSelectMany = true } = {}) {
		this.id = id;
		this.repos = repos;
		this._em = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._em.event;
		this.view = vscode.window.createTreeView(id, { treeDataProvider: this, showCollapseAll, canSelectMany });
		this.disposables = [
			this._em,
			this.view,
			repos.onDidChangeRepo(root => (!root || root === repos.active) && this.refresh()),
			repos.onDidChangeActive(() => this.refresh()),
		];
	}
	dispose() {
		for (const d of this.disposables) d.dispose();
	}
	refresh(node) {
		this._em.fire(node);
	}
	getTreeItem(node) {
		return node.toItem();
	}
	async getChildren(node) {
		try {
			if (node) return (await node.children?.(this)) ?? [];
			await this.repos.ready;
			const root = this.repos.active;
			this.view.description = root ? path.basename(root) : undefined;
			if (!root) return [new MessageNode('No git repository found')];
			const nodes = await this.roots(root);
			return nodes.length ? nodes : [new MessageNode(this.emptyText || 'Nothing to show')];
		} catch (e) {
			return [new MessageNode(String(e.stderr || e.message || e).split('\n')[0], 'error')];
		}
	}
}

class CommitsView extends BaseView {
	constructor(repos) {
		super('revwise.commits', repos);
		this.emptyText = 'No commits yet';
		this.sources = new Map();
	}
	async roots(root) {
		const branch = await git.currentBranch(root);
		this.view.description = `${path.basename(root)} • ${branch || 'detached HEAD'}`;
		let source = this.sources.get(root);
		if (!source) this.sources.set(root, (source = new CommitSource(root, ['HEAD', '--'])));
		return source.nodes(this, undefined);
	}
}

class BranchesView extends BaseView {
	constructor(repos) {
		super('revwise.branches', repos);
		this.emptyText = 'No branches';
	}
	async roots(root) {
		const list = (await git.branches(root)).filter(b => !b.remote);
		list.sort((a, b) => (b.current - a.current) || b.date - a.date);
		return list.map(b => new BranchNode(root, b));
	}
}

class RemotesView extends BaseView {
	constructor(repos) {
		super('revwise.remotes', repos);
		this.emptyText = 'No remotes';
	}
	async roots(root) {
		return (await git.remotes(root)).map(r => new RemoteNode(root, r));
	}
}

class StashesView extends BaseView {
	constructor(repos) {
		super('revwise.stashes', repos);
		this.emptyText = 'No stashes';
	}
	async roots(root) {
		return (await git.stashes(root)).map(s => new StashNode(root, s));
	}
}

class TagsView extends BaseView {
	constructor(repos) {
		super('revwise.tags', repos);
		this.emptyText = 'No tags';
	}
	async roots(root) {
		return (await git.tags(root)).map(t => new TagNode(root, t));
	}
}

class WorktreesView extends BaseView {
	constructor(repos) {
		super('revwise.worktrees', repos, { showCollapseAll: false });
		this.emptyText = 'No worktrees';
	}
	async roots(root) {
		return (await git.worktrees(root)).map(w => new WorktreeNode(root, w));
	}
}

class ContributorsView extends BaseView {
	constructor(repos) {
		super('revwise.contributors', repos);
		this.emptyText = 'No contributors';
	}
	async roots(root) {
		const list = await git.contributors(root);
		const total = list.reduce((n, c) => n + c.count, 0);
		return list.map(c => new ContributorNode(root, c, total));
	}
}

/** Follows the active editor's file. */
class FileHistoryView extends BaseView {
	constructor(repos) {
		super('revwise.fileHistory', repos, { showCollapseAll: false });
		this.fsPath = undefined;
		this.emptyText = 'No history';
		const update = () => {
			const p = activeFilePath();
			if (p && p !== this.fsPath) {
				this.fsPath = p;
				this.refresh();
			}
		};
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(update));
		update();
	}
	async getChildren(node) {
		if (!node && !this.fsPath) return [new MessageNode('Open a file to see its history')];
		return super.getChildren(node);
	}
	async roots() {
		const fsPath = this.fsPath;
		const root = await this.repos.resolve(fsPath);
		if (!root) return [new MessageNode('File is not in a git repository')];
		this.view.description = path.basename(fsPath);
		const entries = await git.fileLog(root, fsPath, cfg().get('history.limit', 200));
		return entries.map(
			e =>
				new CommitNode(root, { ...e, parents: e.parent ? [e.parent] : [], email: '', refs: [] }, { file: { fsPath }, filename: e.filename }),
		);
	}
}

/** History of the selected lines in the active editor (`git log -L`). */
class LineHistoryView extends BaseView {
	constructor(repos) {
		super('revwise.lineHistory', repos, { showCollapseAll: false });
		this.target = undefined;
		this.emptyText = 'No history for these lines';
		let timer;
		const schedule = () => {
			clearTimeout(timer);
			timer = setTimeout(() => this._update(), 400);
		};
		this.disposables.push(
			vscode.window.onDidChangeTextEditorSelection(e => e.textEditor === vscode.window.activeTextEditor && schedule()),
			vscode.window.onDidChangeActiveTextEditor(schedule),
			vscode.workspace.onDidSaveTextDocument(schedule),
			this.view.onDidChangeVisibility(() => this.view.visible && schedule()),
		);
		this._update();
	}
	_update() {
		if (!this.view.visible) return;
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.scheme !== 'file') return;
		const sel = editor.selection;
		const start = sel.start.line + 1;
		const end = Math.max(start, sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1));
		const t = { fsPath: editor.document.uri.fsPath, start, end, dirty: editor.document.isDirty };
		const k = `${t.fsPath}:${t.start}:${t.end}`;
		if (k === this.key) return;
		this.key = k;
		this.target = t;
		this.refresh();
	}
	async getChildren(node) {
		if (!node && !this.target) return [new MessageNode('Select lines in an editor to see their history')];
		return super.getChildren(node);
	}
	async roots() {
		const t = this.target;
		const root = await this.repos.resolve(t.fsPath);
		if (!root) return [new MessageNode('File is not in a git repository')];
		this.view.description = `${path.basename(t.fsPath)}:${t.start}${t.end !== t.start ? `-${t.end}` : ''}`;
		const nodes = [];
		if (t.dirty) nodes.push(new MessageNode('Unsaved changes are not included', 'warning'));
		const commits = await git.lineLog(root, t.fsPath, t.start, t.end, cfg().get('history.limit', 200));
		for (const c of commits) nodes.push(new CommitNode(root, c, { file: { fsPath: t.fsPath } }));
		return nodes;
	}
}

/** Saved searches and comparisons. */
class SearchCompareView extends BaseView {
	constructor(repos) {
		super('revwise.searchCompare', repos);
		this.items = [];
		this.emptyText = 'Use Search Commits or Compare to add results';
	}
	async getChildren(node) {
		if (!node && !this.items.length) return [new MessageNode(this.emptyText, 'search')];
		if (!node) return this.items;
		return super.getChildren(node);
	}
	_add(node) {
		this.items.unshift(node);
		this.refresh();
		vscode.commands.executeCommand('revwise.searchCompare.focus').then(
			() => this.view.reveal(node, { expand: true, focus: true, select: true }),
			() => {},
		);
	}
	remove(node) {
		this.items = this.items.filter(n => n !== node);
		this.refresh();
	}
	clear() {
		this.items = [];
		this.refresh();
	}
	getParent() {
		return undefined;
	}
	addSearch(root, mode, query) {
		const limit = cfg().get('history.limit', 200);
		let cache;
		const node = new GroupNode(
			`"${query}"`,
			'search',
			async provider => {
				if (cache) return cache;
				const commits = await git.searchCommits(root, mode, query, limit);
				node.description = `${mode} • ${commits.length}${commits.length >= limit ? '+' : ''} results • ${path.basename(root)}`;
				cache = commits.length ? commits.map(c => new CommitNode(root, c)) : [new MessageNode('No results')];
				provider.refresh(node);
				return cache;
			},
			{ description: `${mode} • ${path.basename(root)}`, contextValue: 'searchResult' },
		);
		this._add(node);
	}
	addCompare(root, left, right) {
		const rightLabel = right || 'Working Tree';
		const leftLabel = /^[0-9a-f]{40}$/.test(left) ? shortSha(left) : left;
		const rLabel = right && /^[0-9a-f]{40}$/.test(right) ? shortSha(right) : rightLabel;
		const commitsSource = right ? new CommitSource(root, [`${left}..${right}`, '--']) : undefined;
		const behindSource = right ? new CommitSource(root, [`${right}..${left}`, '--']) : undefined;
		const children = [];
		if (right) {
			children.push(
				new GroupNode(`Commits in ${rLabel} not in ${leftLabel}`, 'arrow-up', (p, n) => commitsSource.nodes(p, n), { expanded: false }),
				new GroupNode(`Commits in ${leftLabel} not in ${rLabel}`, 'arrow-down', (p, n) => behindSource.nodes(p, n), { expanded: false }),
			);
		}
		children.push(
			new GroupNode(
				'Files changed',
				'files',
				async () => {
					// Three-dot for ref↔ref (changes since merge base); two-dot vs working tree.
					const files = right ? await git.diffFiles(root, `${left}...${right}`) : await git.diffFiles(root, left);
					const base = right ? (await git.run(['merge-base', left, right], { cwd: root })).trim() : left;
					return files.length ? files.map(f => new FileNode(root, f, base, right)) : [new MessageNode('No changes')];
				},
				{ expanded: true },
			),
		);
		const node = new GroupNode(`${leftLabel} ↔ ${rLabel}`, 'git-compare', async () => children, {
			description: path.basename(root),
			contextValue: 'compareResult',
		});
		this._add(node);
	}
}

class JournalNode {
	constructor(root, entry, journal) {
		this.root = root;
		this.entry = entry;
		this.journal = journal;
	}
	toItem() {
		const e = this.entry;
		const item = new vscode.TreeItem(e.label);
		item.description = fromNow(e.time);
		item.tooltip = `${e.label}\n${e.time.toLocaleString()}\n\nUndo: ${this.journal.describe(e)}`;
		item.iconPath = new vscode.ThemeIcon('history');
		item.contextValue = 'journalEntry';
		return item;
	}
}

class ReflogNode extends CommitNode {
	constructor(root, entry) {
		super(root, entry);
		this.entry = entry;
	}
	toItem() {
		const e = this.entry;
		const item = new vscode.TreeItem(e.action, vscode.TreeItemCollapsibleState.Collapsed);
		item.description = `${e.selector} • ${shortSha(e.sha)} • ${fromNow(e.date)}`;
		item.tooltip = new vscode.MarkdownString(undefined, true);
		item.tooltip.appendMarkdown(`**${e.selector}** — ${e.action}\n\n`);
		item.tooltip.appendText(`${e.summary}\n`);
		item.tooltip.appendMarkdown(`\n$(git-commit) \`${e.sha}\` • ${e.date.toLocaleString()}\n\n_Right-click to reset the current branch here or create a branch to rescue lost commits._`);
		const icon = /^commit/.test(e.action)
			? 'git-commit'
			: /^checkout/.test(e.action)
				? 'arrow-swap'
				: /^rebase/.test(e.action)
					? 'git-pull-request-draft'
					: /^reset/.test(e.action)
						? 'discard'
						: /^merge|pull/.test(e.action)
							? 'git-merge'
							: 'circle-small';
		item.iconPath = new vscode.ThemeIcon(icon);
		item.contextValue = 'reflog';
		return item;
	}
}

/** Revwise's undo journal plus the HEAD reflog, for recovering from mistakes. */
class UndoView extends BaseView {
	constructor(repos, journal) {
		super('revwise.undo', repos);
		this.journal = journal;
		this.reflogLimit = 100;
		this.disposables.push(journal.onDidChange(() => this.refresh()));
	}
	async roots(root) {
		const entries = this.journal.list(root);
		const ops = new GroupNode(
			'Revwise Operations',
			'history',
			async () => (entries.length ? entries.map(e => new JournalNode(root, e, this.journal)) : [new MessageNode('Nothing to undo yet')]),
			{ description: entries.length ? `${entries.length} undoable` : undefined, expanded: true },
		);
		const ref = new GroupNode(
			'HEAD Reflog',
			'list-ordered',
			async () => {
				const list = await git.reflog(root, this.reflogLimit);
				return list.length ? list.map(e => new ReflogNode(root, e)) : [new MessageNode('Reflog is empty')];
			},
			{ description: 'every place HEAD has been', expanded: false },
		);
		return [ops, ref];
	}
}

function activeFilePath() {
	const uri = vscode.window.activeTextEditor?.document.uri;
	if (!uri) return undefined;
	if (uri.scheme === 'file') return uri.fsPath;
	if (uri.scheme === 'revwise') {
		try {
			return JSON.parse(uri.query).fsPath || undefined;
		} catch {}
	}
	return undefined;
}

function createViews(repos, { journal } = {}) {
	return {
		commits: new CommitsView(repos),
		branches: new BranchesView(repos),
		remotes: new RemotesView(repos),
		stashes: new StashesView(repos),
		tags: new TagsView(repos),
		worktrees: new WorktreesView(repos),
		contributors: new ContributorsView(repos),
		fileHistory: new FileHistoryView(repos),
		lineHistory: new LineHistoryView(repos),
		searchCompare: new SearchCompareView(repos),
		...(journal ? { undo: new UndoView(repos, journal) } : {}),
	};
}

module.exports = { createViews, CommitNode, FileNode, BranchNode, TagNode, StashNode, WorktreeNode, RemoteNode, LoadMoreNode, GroupNode, JournalNode, ReflogNode };
