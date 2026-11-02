'use strict';
const vscode = require('vscode');
const path = require('path');
const git = require('./git');
const { shortSha } = require('./format');

const SCHEME = 'revwise';

/** Read-only document for `gitPath` at `ref`. `fsPath` (working-tree path) enables revision navigation. */
function gitUri(root, ref, gitPath, fsPath) {
	return vscode.Uri.from({
		scheme: SCHEME,
		path: '/' + gitPath,
		query: JSON.stringify({ root, ref, fsPath }),
	});
}

function commitUri(root, sha) {
	return vscode.Uri.from({
		scheme: SCHEME,
		path: `/commit-${shortSha(sha)}.diff`,
		query: JSON.stringify({ root, commit: sha }),
	});
}

function parse(uri) {
	if (uri?.scheme !== SCHEME) return undefined;
	try {
		const q = JSON.parse(uri.query);
		return { ...q, gitPath: uri.path.slice(1) };
	} catch {
		return undefined;
	}
}

const contentProvider = {
	async provideTextDocumentContent(uri) {
		const q = parse(uri);
		if (!q) return '';
		try {
			if (q.commit) return await git.showCommit(q.root, q.commit);
			return await git.show(q.root, q.ref, q.gitPath);
		} catch {
			// File didn't exist at that revision (added/root commit): diff against empty.
			return '';
		}
	},
};

/** Diff a file between two refs. `right` undefined means the working-tree file. */
function diffFile(root, left, leftPath, right, rightPath, title) {
	const fsPath = path.join(root, rightPath || leftPath);
	const l = gitUri(root, left, leftPath, fsPath);
	const r = right ? gitUri(root, right, rightPath || leftPath, fsPath) : vscode.Uri.file(fsPath);
	const name = path.basename(rightPath || leftPath);
	const label = ref => (ref && /^[0-9a-f]{40}/.test(ref) ? shortSha(ref) + ref.slice(40) : ref || 'Working Tree');
	return vscode.commands.executeCommand('vscode.diff', l, r, title || `${name} (${label(left)}) ↔ (${label(right)})`);
}

async function showCommitDocument(root, sha) {
	const doc = await vscode.workspace.openTextDocument(commitUri(root, sha));
	await vscode.window.showTextDocument(doc, { preview: true });
}

module.exports = { SCHEME, gitUri, commitUri, parse, contentProvider, diffFile, showCommitDocument };
