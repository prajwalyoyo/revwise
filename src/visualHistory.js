'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const git = require('./git');
const { diffFile } = require('./uris');

/**
 * Visual File History: a timeline of every commit that touched the active file.
 * Each commit is a bubble on its author's lane (size = lines changed), with an additions/deletions
 * bar chart underneath. Shown as a sidebar view and as an editor panel.
 */
class VisualHistoryController {
	constructor(context, repos) {
		this.context = context;
		this.repos = repos;
		this.hosts = new Set();
		this.panel = undefined;
		this.fsPath = undefined;
		this.disposables = [
			vscode.window.registerWebviewViewProvider('revwise.visualHistory', this),
			vscode.commands.registerCommand('revwise.showVisualHistory', uri => this.showPanel(uri)),
			vscode.window.onDidChangeActiveTextEditor(() => this._follow()),
			repos.onDidChangeRepo(() => this._reloadAll()),
		];
		this._follow(false);
	}

	dispose() {
		this.panel?.dispose();
		for (const d of this.disposables) d.dispose();
	}

	_activePath() {
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

	_follow(reload = true) {
		const p = this._activePath();
		if (!p || p === this.fsPath) return;
		this.fsPath = p;
		if (reload) for (const h of this.hosts) if (!h.pinned) this._load(h, p);
	}

	_reloadAll() {
		for (const h of this.hosts) if (h.fsPath) this._load(h, h.fsPath);
	}

	resolveWebviewView(view) {
		this._attach(view.webview, view, 'view');
	}

	showPanel(uri) {
		const fsPath = uri instanceof vscode.Uri ? uri.fsPath : this._activePath() || this.fsPath;
		if (!fsPath) {
			vscode.window.showInformationMessage('Revwise: open a file to see its visual history.');
			return;
		}
		if (!this.panel) {
			const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
			this.panel = vscode.window.createWebviewPanel(
				'revwise.visualHistoryPanel',
				'Visual File History',
				{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
				{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
			);
			this.panel.iconPath = {
			light: vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'revwise-light.svg'),
			dark: vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'revwise-dark.svg'),
		};
			this._attach(this.panel.webview, this.panel, 'panel', fsPath);
			this.panel.onDidDispose(() => (this.panel = undefined));
		} else {
			this.panel.reveal(undefined, true);
			const h = [...this.hosts].find(x => x.owner === this.panel);
			if (h) this._load(h, fsPath);
		}
	}

	_attach(webview, owner, kind, fsPath) {
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		webview.options = { enableScripts: true, localResourceRoots: [media] };
		const host = { webview, owner, kind, fsPath: fsPath || this.fsPath, seq: 0 };
		this.hosts.add(host);
		webview.html = this._html(webview);
		const subs = [
			webview.onDidReceiveMessage(m => this._onMessage(host, m)),
			(owner.onDidChangeVisibility ?? owner.onDidChangeViewState).call(owner, () => {
				if (owner.visible && host.stale) this._load(host, host.fsPath);
			}),
		];
		owner.onDidDispose(() => {
			this.hosts.delete(host);
			for (const s of subs) s.dispose();
		});
	}

	async _onMessage(host, m) {
		if (m.type === 'ready') return this._load(host, host.fsPath || this.fsPath);
		if (m.type === 'open' && host.root) {
			const c = host.commits.find(x => x.sha === m.sha);
			if (!c) return;
			const i = host.commits.indexOf(c);
			const older = host.commits[i + 1];
			return diffFile(host.root, c.parent ?? git.EMPTY_TREE, older?.filename ?? c.filename, c.sha, c.filename);
		}
		if (m.type === 'showCommit') return vscode.commands.executeCommand('revwise.showCommitDetails', { root: host.root, sha: m.sha });
	}

	async _load(host, fsPath) {
		if (!fsPath) return host.webview.postMessage({ type: 'empty', message: 'Open a file to see its visual history.' });
		host.fsPath = fsPath;
		if (!host.owner.visible) {
			host.stale = true;
			return;
		}
		host.stale = false;
		const seq = ++host.seq;
		const root = await this.repos.resolve(fsPath);
		if (!root) return host.webview.postMessage({ type: 'empty', message: `${path.basename(fsPath)} is not in a git repository.` });
		host.webview.postMessage({ type: 'loading', file: path.basename(fsPath) });
		try {
			const commits = await git.fileStatsLog(root, fsPath);
			if (seq !== host.seq) return;
			host.root = root;
			host.commits = commits;
			if (host.kind === 'panel') host.owner.title = `History: ${path.basename(fsPath)}`;
			host.webview.postMessage({
				type: 'data',
				file: git.toGitPath(root, fsPath),
				commits: commits.map(c => ({
					sha: c.sha,
					author: c.author,
					email: c.email,
					date: c.date.getTime(),
					summary: c.summary,
					adds: c.adds,
					dels: c.dels,
					binary: c.binary,
				})),
			});
		} catch (e) {
			if (seq === host.seq) host.webview.postMessage({ type: 'empty', message: String(e.stderr || e.message || e).split('\n')[0] });
		}
	}

	_html(webview) {
		const nonce = crypto.randomBytes(16).toString('base64');
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'history.css'));
		const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'history.js'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Visual File History</title>
</head>
<body>
<div class="toolbar">
	<span id="file" class="file"></span>
	<span class="spacer"></span>
	<span class="ranges" id="ranges">
		<button data-range="30">1M</button><button data-range="90">3M</button><button data-range="365">1Y</button><button data-range="0" class="on">All</button>
	</span>
</div>
<div id="summary" class="muted"></div>
<div id="chart"></div>
<div id="tip" class="tip hidden"></div>
<div id="legend"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}
}

module.exports = { VisualHistoryController };
