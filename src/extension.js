'use strict';
const vscode = require('vscode');
const path = require('path');
const git = require('./git');
const { BlameService } = require('./blameService');
const { RepoManager } = require('./repo');
const { AnnotationController } = require('./annotations');
const { GraphController } = require('./graphView');
const { RevisionNavigator } = require('./revisions');
const { createViews } = require('./views');
const { registerCommands } = require('./commands');
const { registerHistoryCommands } = require('./historyCommands');
const { Journal } = require('./journal');
const { ChangelistsView, registerChangelistCommands } = require('./changelists');
const { VisualHistoryController } = require('./visualHistory');
const { showPatch } = require('./patches');
const { SCHEME, gitUri, contentProvider, showCommitDocument } = require('./uris');
const { fromNow, shortSha, formatTemplate } = require('./format');

const cfg = () => vscode.workspace.getConfiguration('revwise');

function debounce(fn, ms) {
	let t;
	const d = (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
	d.cancel = () => clearTimeout(t);
	return d;
}

// ---------- commit actions ----------

function commitArgs(root, fsPath, commit, lineInfo) {
	return {
		root,
		fsPath,
		sha: commit.sha,
		summary: commit.summary,
		uncommitted: commit.uncommitted,
		filename: lineInfo?.filename ?? commit.filename,
		previousSha: commit.previousSha,
		previousFilename: commit.previousFilename,
	};
}

async function diffWithPrevious(a) {
	if (!a) return;
	const name = path.basename(a.fsPath);
	if (a.uncommitted) {
		const rel = git.toGitPath(a.root, a.fsPath);
		return vscode.commands.executeCommand(
			'vscode.diff',
			gitUri(a.root, 'HEAD', rel, a.fsPath),
			vscode.Uri.file(a.fsPath),
			`${name} (HEAD) ↔ (Working Tree)`,
		);
	}
	const prevSha = a.previousSha ?? `${a.sha}^`;
	const left = gitUri(a.root, prevSha, a.previousFilename ?? a.filename, a.fsPath);
	const right = gitUri(a.root, a.sha, a.filename, a.fsPath);
	return vscode.commands.executeCommand(
		'vscode.diff',
		left,
		right,
		`${name} (${shortSha(a.previousSha ?? a.sha) + (a.previousSha ? '' : '^')}) ↔ (${shortSha(a.sha)})`,
	);
}

async function showCommit(a) {
	if (!a || a.uncommitted) return diffWithPrevious(a);
	await showCommitDocument(a.root, a.sha);
}

// ---------- current line: inline annotation + status bar + hover ----------

class CurrentLineController {
	constructor(blame) {
		this.blame = blame;
		this.state = undefined;
		this.seq = 0;
		/** Set by activate(): true when another annotation already shows blame for the document. */
		this.isSuppressed = () => false;
		this.decoration = vscode.window.createTextEditorDecorationType({
			after: { margin: '0 0 0 3em', textDecoration: 'none' },
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
		});
		this.statusBar = vscode.window.createStatusBarItem('revwise.blame', vscode.StatusBarAlignment.Right, 1000);
		this.statusBar.name = 'Revwise Blame';

		this.schedule = () => this._debounced();
		this._rebuildDebounce();

		this.disposables = [
			this.decoration,
			this.statusBar,
			vscode.window.onDidChangeTextEditorSelection(e => {
				if (e.textEditor === vscode.window.activeTextEditor) this.schedule();
			}),
			vscode.window.onDidChangeActiveTextEditor(() => {
				this.clear();
				this.schedule();
			}),
			vscode.workspace.onDidChangeTextDocument(e => {
				if (e.document === vscode.window.activeTextEditor?.document && e.contentChanges.length) {
					this.clear();
					this.schedule();
				}
			}),
			blame.onDidChange(() => this.schedule()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('revwise')) {
					this._rebuildDebounce();
					this.clear();
					this.schedule();
				}
			}),
			vscode.languages.registerHoverProvider({ scheme: 'file' }, this),
		];
		this.schedule();
	}

	_rebuildDebounce() {
		this._debounced?.cancel();
		this._debounced = debounce(() => this.refresh(), Math.max(0, cfg().get('currentLine.delay', 100)));
	}

	dispose() {
		this._debounced?.cancel();
		for (const d of this.disposables) d.dispose();
	}

	clear() {
		this.seq++;
		this.state = undefined;
		vscode.window.activeTextEditor?.setDecorations(this.decoration, []);
		for (const e of vscode.window.visibleTextEditors) e.setDecorations(this.decoration, []);
		this.statusBar.hide();
	}

	async refresh() {
		const editor = vscode.window.activeTextEditor;
		const seq = ++this.seq;
		const c = cfg();
		const lineEnabled = c.get('currentLine.enabled', true);
		const statusEnabled = c.get('statusBar.enabled', true);
		if (!editor || (!lineEnabled && !statusEnabled && !c.get('hovers.enabled', true))) return this.clear();

		const line = editor.selection.active.line;
		const res = await this.blame.get(editor.document);
		if (seq !== this.seq || editor !== vscode.window.activeTextEditor) return;
		const info = res?.blame.lines[line];
		const commit = info && res.blame.commits.get(info.sha);
		if (!commit) {
			editor.setDecorations(this.decoration, []);
			this.statusBar.hide();
			this.state = undefined;
			return;
		}

		const you = c.get('youEmail') || undefined;
		this.state = { uri: editor.document.uri.toString(), line, root: res.root, commit, info };
		const args = commitArgs(res.root, editor.document.uri.fsPath, commit, info);

		if (lineEnabled && editor.selections.length === 1 && !this.isSuppressed(editor.document)) {
			const text = formatTemplate(c.get('currentLine.format'), commit, { you });
			const end = editor.document.lineAt(line).range.end;
			editor.setDecorations(this.decoration, [
				{
					range: new vscode.Range(end, end),
					renderOptions: {
						after: {
							contentText: text,
							color: new vscode.ThemeColor('revwise.trailingLineForegroundColor'),
						},
					},
				},
			]);
		} else {
			editor.setDecorations(this.decoration, []);
		}

		if (statusEnabled) {
			this.statusBar.text = `$(git-commit) ${formatTemplate(c.get('statusBar.format'), commit, { you })}`;
			this.statusBar.tooltip = this.hoverMarkdown(this.state);
			this.statusBar.command = { title: 'Show Commit', command: 'revwise.showCommit', arguments: [args] };
			this.statusBar.show();
		} else {
			this.statusBar.hide();
		}
	}

	async provideHover(document, position) {
		const s = this.state;
		if (!s || !cfg().get('hovers.enabled', true)) return;
		if (s.uri !== document.uri.toString() || s.line !== position.line) return;
		if (this.isSuppressed(document)) return;
		if (cfg().get('hovers.over', 'annotation') === 'annotation') {
			// Hovering the injected `after` text reports the end-of-line position.
			if (position.character < document.lineAt(position.line).range.end.character) return;
		}
		const note = s.commit.uncommitted ? undefined : await this.noteFor(s.root, s.commit.sha);
		return new vscode.Hover(this.hoverMarkdown(s, note));
	}

	/** git notes are rarely present; cache lookups (including misses) per commit. */
	noteFor(root, sha) {
		this.notes ??= new Map();
		const key = `${root}|${sha}`;
		if (!this.notes.has(key)) {
			if (this.notes.size > 500) this.notes.clear();
			this.notes.set(key, git.notes(root, sha));
		}
		return this.notes.get(key);
	}

	hoverMarkdown(s, note) {
		const { commit } = s;
		const md = new vscode.MarkdownString(undefined, true);
		md.isTrusted = { enabledCommands: ['revwise.showCommit', 'revwise.diffWithPrevious', 'revwise.copySha', 'revwise.rewordCommit'] };
		md.supportHtml = false;
		if (commit.uncommitted) {
			md.appendMarkdown('$(edit) **Uncommitted changes**\n\n');
			const a = encodeURIComponent(JSON.stringify([commitArgs(s.root, vscode.Uri.parse(s.uri).fsPath, commit, s.info)]));
			md.appendMarkdown(`[$(diff) Compare with HEAD](command:revwise.diffWithPrevious?${a})`);
			return md;
		}
		const esc = t => (t || '').replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
		const a = encodeURIComponent(JSON.stringify([commitArgs(s.root, vscode.Uri.parse(s.uri).fsPath, commit, s.info)]));
		md.appendMarkdown(`$(account) **${esc(commit.author)}**`);
		if (commit.email) md.appendMarkdown(` \\<${esc(commit.email)}\\>`);
		md.appendMarkdown(`, ${esc(fromNow(commit.date))} (${esc(commit.date.toLocaleString())})\n\n`);
		md.appendMarkdown(`${esc(commit.summary)}\n\n`);
		if (note) md.appendMarkdown(`$(note) _Note:_ ${esc(note).replace(/\n/g, '  \n')}\n\n`);
		md.appendMarkdown('---\n\n');
		md.appendMarkdown(
			`[$(git-commit) ${shortSha(commit.sha)}](command:revwise.showCommit?${a} "Show Commit") ` +
				`&nbsp;|&nbsp; [$(diff) Diff with Previous](command:revwise.diffWithPrevious?${a}) ` +
				`&nbsp;|&nbsp; [$(copy) Copy SHA](command:revwise.copySha?${a}) ` +
				`&nbsp;|&nbsp; [$(edit) Reword](command:revwise.rewordCommit?${a} "Edit this commit's message")`,
		);
		return md;
	}
}

// ---------- CodeLens: recent change + authors ----------

class BlameCodeLensProvider {
	constructor(blame) {
		this.blame = blame;
		this.lastGood = new Map();
		this._onDidChange = new vscode.EventEmitter();
		this.onDidChangeCodeLenses = this._onDidChange.event;
		this.disposable = vscode.Disposable.from(
			this._onDidChange,
			blame.onDidChange(() => this._onDidChange.fire()),
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('revwise.codeLens') && this._onDidChange.fire()),
			vscode.workspace.onDidCloseTextDocument(d => this.lastGood.delete(d.uri.toString())),
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
		);
	}

	dispose() {
		this.disposable.dispose();
	}

	async provideCodeLenses(document, token) {
		if (!cfg().get('codeLens.enabled', true)) return [];
		const key = document.uri.toString();
		// Avoid re-blaming on every keystroke; dirty files reuse the last saved result.
		const res = document.isDirty ? this.lastGood.get(key) : await this.blame.get(document);
		if (!res || token.isCancellationRequested) return [];
		if (!document.isDirty) this.lastGood.set(key, res);

		const authors = new Map();
		let latest;
		for (const info of res.blame.lines) {
			if (!info) continue;
			const c = res.blame.commits.get(info.sha);
			if (c.uncommitted) continue;
			authors.set(c.author, (authors.get(c.author) || 0) + 1);
			if (!latest || c.date > latest.date) latest = c;
		}
		if (!latest) return [];
		const range = new vscode.Range(0, 0, 0, 0);
		const sorted = [...authors.entries()].sort((a, b) => b[1] - a[1]);
		const args = commitArgs(res.root, document.uri.fsPath, latest);
		return [
			new vscode.CodeLens(range, {
				title: `$(history) ${latest.author}, ${fromNow(latest.date)}`,
				tooltip: latest.summary,
				command: 'revwise.showCommit',
				arguments: [args],
			}),
			new vscode.CodeLens(range, {
				title: `$(person) ${sorted.length} ${sorted.length === 1 ? 'author' : 'authors'} (${sorted[0][0]}${sorted.length > 1 ? ' and others' : ''})`,
				command: 'revwise.toggleFileBlame',
				arguments: [],
			}),
		];
	}
}

// ---------- file history ----------

async function fileHistory() {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.uri.scheme !== 'file') return;
	const fsPath = editor.document.uri.fsPath;
	const root = await git.getRepoRoot(path.dirname(fsPath));
	if (!root) return vscode.window.showInformationMessage('Revwise: this file is not in a git repository.');
	const entries = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'Revwise: loading history' },
		() => git.fileLog(root, fsPath, cfg().get('history.limit', 200)),
	);
	if (!entries.length) return vscode.window.showInformationMessage('Revwise: no history for this file.');
	const pick = await vscode.window.showQuickPick(
		entries.map((e, i) => ({
			label: `$(git-commit) ${e.summary}`,
			description: `${e.author}, ${fromNow(e.date)}`,
			detail: `${shortSha(e.sha)}  ${e.filename}`,
			entry: e,
			older: entries[i + 1],
		})),
		{ title: `History: ${path.basename(fsPath)}`, matchOnDescription: true, matchOnDetail: true },
	);
	if (!pick) return;
	const e = pick.entry;
	return diffWithPrevious({
		root,
		fsPath,
		sha: e.sha,
		filename: e.filename,
		previousSha: e.parent,
		previousFilename: pick.older?.filename ?? e.filename,
	});
}

function argsForActiveLine(blameService) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return Promise.resolve(undefined);
	return blameService.get(editor.document).then(res => {
		const info = res?.blame.lines[editor.selection.active.line];
		if (!info) return undefined;
		return commitArgs(res.root, editor.document.uri.fsPath, res.blame.commits.get(info.sha), info);
	});
}

// ---------- activation ----------

function activate(context) {
	const repos = new RepoManager();
	const blame = new BlameService(repos);
	const currentLine = new CurrentLineController(blame);
	const annotations = new AnnotationController(blame, repos, { hover: s => currentLine.hoverMarkdown(s) });
	currentLine.isSuppressed = doc => annotations.modeOf(doc) === 'blame';
	const codeLens = new BlameCodeLensProvider(blame);
	const graph = new GraphController(context, repos);
	const revisions = new RevisionNavigator(repos);
	const journal = new Journal(context);
	const views = createViews(repos, { journal });
	const changelists = new ChangelistsView(context, repos, journal);
	const visualHistory = new VisualHistoryController(context, repos);

	const withArgs = fn => async a => fn(a ?? (await argsForActiveLine(blame)));

	context.subscriptions.push(
		repos,
		blame,
		currentLine,
		annotations,
		codeLens,
		graph,
		revisions,
		journal,
		changelists,
		visualHistory,
		...Object.values(views),
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
		annotations.onDidChangeMode(() => currentLine.schedule()),
		vscode.commands.registerCommand('revwise.toggleFileBlame', () => annotations.toggle('blame')),
		vscode.commands.registerCommand('revwise.toggleHeatmap', () => annotations.toggle('heatmap')),
		vscode.commands.registerCommand('revwise.toggleChanges', () => annotations.toggle('changes')),
		vscode.commands.registerCommand('revwise.clearAnnotations', () => annotations.clear()),
		vscode.commands.registerCommand('revwise.toggleCurrentLineBlame', async () => {
			const c = cfg();
			await c.update('currentLine.enabled', !c.get('currentLine.enabled', true), vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('revwise.showCommit', withArgs(showCommit)),
		vscode.commands.registerCommand('revwise.diffWithPrevious', withArgs(diffWithPrevious)),
		vscode.commands.registerCommand(
			'revwise.copySha',
			withArgs(async a => {
				if (!a || a.uncommitted) return;
				await vscode.env.clipboard.writeText(a.sha);
				vscode.window.setStatusBarMessage(`$(check) Copied ${shortSha(a.sha)}`, 2000);
			}),
		),
		vscode.commands.registerCommand('revwise.fileHistory', fileHistory),
		vscode.commands.registerCommand('revwise.refresh', () => {
			blame.invalidateAll();
			repos.refresh();
		}),
		vscode.commands.registerCommand('revwise.openPreviousRevision', () => revisions.previous()),
		vscode.commands.registerCommand('revwise.openNextRevision', () => revisions.next()),
		vscode.commands.registerCommand('revwise.openWorkingFile', () => revisions.openWorkingFile()),
		vscode.commands.registerCommand('revwise.openRevision', a => revisions.openRevision(a)),
	);

	const blameArgsForActiveLine = () => argsForActiveLine(blame);
	registerCommands(context, { repos, views, blameArgsForActiveLine, journal });
	registerHistoryCommands(context, { repos, views, journal, blameArgsForActiveLine });
	registerChangelistCommands(context, changelists, { showPatch });

	return { repos, blame, views, graph, annotations, journal, changelists, visualHistory };
}

function deactivate() {}

module.exports = { activate, deactivate };
