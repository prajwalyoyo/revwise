'use strict';
const vscode = require('vscode');
const git = require('./git');
const { formatTemplate } = require('./format');

const cfg = () => vscode.workspace.getConfiguration('revwise');
const DAY = 86400000;
const HOT = [246, 106, 10];
const COLD = [10, 96, 246];
const BUCKETS = 5;
const SEPARATOR = 'rgba(128,128,128,0.35)';

function heatColor(hot, bucket) {
	const [r, g, b] = hot ? HOT : COLD;
	const alpha = (1 - bucket / BUCKETS) * 0.85 + 0.15;
	return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

function debounce(fn, ms) {
	let t;
	return (...a) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...a), ms);
	};
}

/**
 * Whole-file annotations, toggled per document:
 *   blame   - gutter with sha/author/age per block of lines
 *   heatmap - left border colored by line age (hot = recent, cold = old)
 *   changes - markers for lines changed by uncommitted edits, or by the file's last commit when clean
 */
class AnnotationController {
	/** @param {{ hover?: (state: { uri: string, line: number, root: string, commit: object, info: object }) => vscode.MarkdownString }} [options] */
	constructor(blame, repos, options = {}) {
		this.blame = blame;
		this.repos = repos;
		this.modes = new Map();
		this.heatTypes = new Map();
		this.hover = options.hover;
		this._onDidChangeMode = new vscode.EventEmitter();
		this.onDidChangeMode = this._onDidChangeMode.event;
		this.gutter = vscode.window.createTextEditorDecorationType({
			rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
			before: {
				width: '42ch',
				margin: '0 1.5em 0 0',
				color: new vscode.ThemeColor('revwise.gutterForegroundColor'),
				backgroundColor: new vscode.ThemeColor('revwise.gutterBackgroundColor'),
				textDecoration:
					'none; white-space: pre; overflow: hidden; text-overflow: ellipsis; display: inline-block; box-sizing: border-box; padding-left: 8px',
			},
		});
		const mk = (color, ruler, extra = {}) =>
			vscode.window.createTextEditorDecorationType({
				isWholeLine: true,
				borderStyle: 'solid',
				borderWidth: '0 0 0 3px',
				borderColor: new vscode.ThemeColor(color),
				overviewRulerColor: new vscode.ThemeColor(ruler),
				overviewRulerLane: vscode.OverviewRulerLane.Left,
				...extra,
			});
		this.changeTypes = {
			added: mk('revwise.changesAddedColor', 'revwise.changesAddedColor'),
			modified: mk('revwise.changesModifiedColor', 'revwise.changesModifiedColor'),
			deleted: vscode.window.createTextEditorDecorationType({
				isWholeLine: true,
				borderStyle: 'solid',
				borderWidth: '2px 0 0 0',
				borderColor: new vscode.ThemeColor('revwise.changesDeletedColor'),
				overviewRulerColor: new vscode.ThemeColor('revwise.changesDeletedColor'),
				overviewRulerLane: vscode.OverviewRulerLane.Left,
			}),
		};
		const refreshDirty = debounce(doc => this.render(doc), 500);
		this.disposables = [
			this.gutter,
			this._onDidChangeMode,
			...Object.values(this.changeTypes),
			blame.onDidChange(() => this.renderAll()),
			repos.onDidChangeRepo(() => this.renderAll()),
			vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
			vscode.window.onDidChangeActiveTextEditor(() => this._updateContext()),
			vscode.workspace.onDidChangeTextDocument(e => {
				if (this.modes.has(e.document.uri.toString()) && e.contentChanges.length) refreshDirty(e.document);
			}),
			vscode.workspace.onDidSaveTextDocument(d => this.modes.has(d.uri.toString()) && this.render(d)),
			vscode.workspace.onDidCloseTextDocument(d => this.modes.delete(d.uri.toString())),
			vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: (d, p) => this._provideHover(d, p) }),
		];
	}

	/** Hovering the injected gutter text reports character 0 of that line. */
	async _provideHover(document, position) {
		if (!this.hover || position.character !== 0 || this.modes.get(document.uri.toString()) !== 'blame') return;
		if (!cfg().get('hovers.enabled', true)) return;
		const res = await this.blame.get(document);
		const info = res?.blame.lines[position.line];
		const commit = info && res.blame.commits.get(info.sha);
		if (!commit) return;
		const md = this.hover({ uri: document.uri.toString(), line: position.line, root: res.root, commit, info });
		return new vscode.Hover(md, new vscode.Range(position.line, 0, position.line, 0));
	}

	dispose() {
		for (const d of this.disposables) d.dispose();
		for (const t of this.heatTypes.values()) t.dispose();
	}

	toggle(mode, editor = vscode.window.activeTextEditor) {
		if (!editor) return;
		const key = editor.document.uri.toString();
		const prev = this.modes.get(key);
		if (prev === mode) this.modes.delete(key);
		else this.modes.set(key, mode);
		this._clear(editor.document);
		this._updateContext();
		this._onDidChangeMode.fire(editor.document);
		return this.render(editor.document);
	}

	clear(editor = vscode.window.activeTextEditor) {
		if (!editor) return;
		this.modes.delete(editor.document.uri.toString());
		this._clear(editor.document);
		this._updateContext();
		this._onDidChangeMode.fire(editor.document);
	}

	modeOf(document) {
		return this.modes.get(document.uri.toString());
	}

	_updateContext() {
		const ed = vscode.window.activeTextEditor;
		const mode = ed ? this.modes.get(ed.document.uri.toString()) : undefined;
		vscode.commands.executeCommand('setContext', 'revwise.annotationMode', mode || '');
	}

	_editors(document) {
		return vscode.window.visibleTextEditors.filter(e => e.document === document);
	}

	_clear(document) {
		for (const e of this._editors(document)) {
			e.setDecorations(this.gutter, []);
			for (const t of Object.values(this.changeTypes)) e.setDecorations(t, []);
			for (const t of this.heatTypes.values()) e.setDecorations(t, []);
		}
	}

	renderAll() {
		const seen = new Set();
		for (const e of vscode.window.visibleTextEditors) {
			if (seen.has(e.document)) continue;
			seen.add(e.document);
			if (this.modes.has(e.document.uri.toString())) this.render(e.document);
		}
		this._updateContext();
	}

	async render(document) {
		const mode = this.modes.get(document.uri.toString());
		if (!mode) return this._clear(document);
		if (mode === 'changes') return this._renderChanges(document);
		const res = await this.blame.get(document);
		if (!res || this.modes.get(document.uri.toString()) !== mode) return;
		if (mode === 'blame') this._renderBlame(document, res);
		else this._renderHeatmap(document, res);
	}

	_renderBlame(document, res) {
		const fmt = cfg().get('fileBlame.format');
		const you = cfg().get('youEmail') || undefined;
		const now = Date.now();
		const threshold = cfg().get('heatmap.ageThreshold', 90) * DAY;
		const oldest = AnnotationController._oldestAge(res, now);
		const decorations = [];
		let prevSha;
		const count = Math.min(document.lineCount, res.blame.lines.length);
		for (let i = 0; i < count; i++) {
			const info = res.blame.lines[i];
			if (!info) continue;
			const commit = res.blame.commits.get(info.sha);
			const first = info.sha !== prevSha;
			prevSha = info.sha;
			const age = commit.uncommitted || !commit.date ? 0 : now - commit.date.getTime();
			const { hot, bucket } = AnnotationController.heatBucket(age, threshold, oldest);
			// Age-colored bar on every line; a faint rule marks where a new commit's block starts.
			const shadows = [`inset 3px 0 0 ${heatColor(hot, bucket)}`];
			if (first && i > 0) shadows.push(`inset 0 1px 0 ${SEPARATOR}`);
			const shown = commit.uncommitted ? { ...commit, uncommitted: false, author: 'You', email: '', summary: 'Uncommitted changes' } : commit;
			decorations.push({
				range: new vscode.Range(i, 0, i, 0),
				renderOptions: {
					before: {
						contentText: first ? formatTemplate(fmt, shown, { maxSummary: 0, you }) : '\u00a0',
						textDecoration: `none; box-shadow: ${shadows.join(', ')}`,
					},
				},
			});
		}
		for (const e of this._editors(document)) e.setDecorations(this.gutter, decorations);
	}

	_heatType(hot, bucket) {
		const key = `${hot ? 'h' : 'c'}${bucket}`;
		let t = this.heatTypes.get(key);
		if (!t) {
			const color = heatColor(hot, bucket);
			t =  vscode.window.createTextEditorDecorationType({
				isWholeLine: true,
				borderStyle: 'solid',
				borderWidth: '0 0 0 3px',
				borderColor: color,
				overviewRulerColor: hot && bucket < 2 ? color : undefined,
				overviewRulerLane: vscode.OverviewRulerLane.Center,
			});
			this.heatTypes.set(key, t);
		}
		return t;
	}

	/** Bucket a line's age: hot within the threshold (linear), cold beyond it (log-scaled to the oldest line). */
	static heatBucket(ageMs, thresholdMs, oldestMs) {
		if (ageMs <= thresholdMs) return { hot: true, bucket: Math.min(BUCKETS - 1, Math.floor((ageMs / thresholdMs) * BUCKETS)) };
		const span = Math.max(1, Math.log(Math.max(oldestMs, thresholdMs + 1) / thresholdMs));
		const pos = Math.log(ageMs / thresholdMs) / span;
		return { hot: false, bucket: Math.min(BUCKETS - 1, Math.floor(pos * BUCKETS)) };
	}

	static _oldestAge(res, now) {
		let oldest = 0;
		for (const c of res.blame.commits.values()) if (c.date) oldest = Math.max(oldest, now - c.date.getTime());
		return oldest;
	}

	_renderHeatmap(document, res) {
		const now = Date.now();
		const threshold = cfg().get('heatmap.ageThreshold', 90) * DAY;
		const oldest = AnnotationController._oldestAge(res, now);
		const groups = new Map();
		const count = Math.min(document.lineCount, res.blame.lines.length);
		for (let i = 0; i < count; i++) {
			const info = res.blame.lines[i];
			if (!info) continue;
			const c = res.blame.commits.get(info.sha);
			const age = c.uncommitted || !c.date ? 0 : now - c.date.getTime();
			const { hot, bucket } = AnnotationController.heatBucket(age, threshold, oldest);
			const t = this._heatType(hot, bucket);
			let list = groups.get(t);
			if (!list) groups.set(t, (list = []));
			list.push(new vscode.Range(i, 0, i, 0));
		}
		for (const e of this._editors(document)) {
			for (const t of this.heatTypes.values()) e.setDecorations(t, groups.get(t) || []);
		}
	}

	async _renderChanges(document) {
		if (document.uri.scheme !== 'file') return;
		const fsPath = document.uri.fsPath;
		const root = await this.repos.resolve(fsPath);
		if (!root) return;
		let hunks = [];
		let against = 'HEAD';
		try {
			hunks = await git.diffHunks(root, 'HEAD', fsPath);
			if (!hunks.length) {
				const [last] = await git.fileLog(root, fsPath, 1);
				if (last) {
					against = last.parent || '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // empty tree for root commits
					hunks = await git.diffHunks(root, against, fsPath);
				}
			}
		} catch {
			// Untracked file or no HEAD yet: everything is new.
			hunks = [{ type: 'added', start: 1, count: document.lineCount }];
		}
		if (this.modes.get(document.uri.toString()) !== 'changes') return;
		const sets = { added: [], modified: [], deleted: [] };
		for (const h of hunks) {
			if (h.type === 'deleted') {
				const line = Math.min(Math.max(0, h.start), document.lineCount - 1);
				sets.deleted.push({ range: new vscode.Range(line, 0, line, 0), hoverMessage: 'Lines deleted above' });
			} else {
				const start = Math.max(0, h.start - 1);
				const end = Math.min(document.lineCount - 1, start + h.count - 1);
				if (end >= start) sets[h.type].push({ range: new vscode.Range(start, 0, end, 0) });
			}
		}
		for (const e of this._editors(document)) {
			for (const [k, t] of Object.entries(this.changeTypes)) e.setDecorations(t, sets[k]);
		}
		this.lastChangesAgainst = against;
	}
}

module.exports = { AnnotationController };
