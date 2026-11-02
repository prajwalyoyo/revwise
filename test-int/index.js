'use strict';
// Integration smoke test, run inside a VS Code extension host (see test-int/run.js).
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000) {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v || Date.now() > end) return v;
		await sleep(100);
	}
}
const hoverText = h => (h || []).flatMap(x => x.contents.map(c => c.value || String(c))).join('\n');

async function run() {
	const repo = process.env.REVWISE_REPO;
	const results = [];
	const check = async (name, fn) => {
		const t = Date.now();
		try {
			await fn();
			results.push({ name, ok: true, ms: Date.now() - t });
		} catch (e) {
			results.push({ name, ok: false, error: String((e && e.stack) || e) });
		}
		fs.writeFileSync(process.env.REVWISE_RESULTS, JSON.stringify(results, null, 2));
	};

	await check('activates', async () => {
		const ext = vscode.extensions.all.find(e => e.id.toLowerCase() === 'revwise.revwise');
		assert.ok(ext, 'extension found');
		await ext.activate();
		assert.ok(ext.isActive);
	});

	const file = vscode.Uri.file(path.join(repo, 'b.txt'));
	const doc = await vscode.workspace.openTextDocument(file);
	const editor = await vscode.window.showTextDocument(doc);

	await check('commands registered', async () => {
		const all = await vscode.commands.getCommands(true);
		for (const c of ['revwise.toggleFileBlame', 'revwise.showCommit', 'revwise.diffWithPrevious', 'revwise.copySha', 'revwise.fileHistory', 'revwise.toggleCurrentLineBlame', 'revwise.refresh']) {
			assert.ok(all.includes(c), c);
		}
	});

	await check('codelens shows latest author + author count', async () => {
		const titles = await until(async () => {
			const l = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', file, 10);
			const t = (l || []).filter(x => x.command && x.command.command.startsWith('revwise')).map(x => x.command.title);
			return t.length === 2 ? t : undefined;
		});
		assert.ok(titles, 'two lenses');
		assert.ok(titles.some(t => /Bob,/.test(t)), JSON.stringify(titles));
		assert.ok(titles.some(t => /2 authors \(/.test(t)), JSON.stringify(titles));
	});

	await check('hover on current-line annotation shows commit', async () => {
		editor.selection = new vscode.Selection(1, 0, 1, 0);
		const text = await until(async () => {
			const t = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', file, doc.lineAt(1).range.end));
			return /Bob/.test(t) && /change line 2/.test(t) ? t : undefined;
		});
		assert.ok(text, 'hover with Bob/summary');
		assert.match(text, /command:revwise\.showCommit/);
	});

	await check('hover not shown mid-line when hovers.over=annotation', async () => {
		const t = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', file, new vscode.Position(1, 0)));
		assert.ok(!/change line 2/.test(t));
	});

	await check('copySha copies the line commit', async () => {
		editor.selection = new vscode.Selection(1, 0, 1, 0);
		await vscode.commands.executeCommand('revwise.copySha');
		assert.match(await vscode.env.clipboard.readText(), /^[0-9a-f]{40}$/);
	});

	await check('diffWithPrevious diffs a.txt before/after', async () => {
		const ed = await vscode.window.showTextDocument(doc);
		ed.selection = new vscode.Selection(1, 0, 1, 0);
		await vscode.commands.executeCommand('revwise.diffWithPrevious');
		const tab = await until(() => {
			const t = vscode.window.tabGroups.activeTabGroup.activeTab;
			return t && t.input instanceof vscode.TabInputTextDiff ? t : undefined;
		});
		assert.ok(tab, 'diff tab opened');
		const left = await vscode.workspace.openTextDocument(tab.input.original);
		const right = await vscode.workspace.openTextDocument(tab.input.modified);
		assert.strictEqual(left.getText().replace(/\r/g, ''), 'one\ntwo\nthree\n');
		assert.strictEqual(right.getText().replace(/\r/g, ''), 'one\nTWO\nthree\n');
	});

	await check('showCommit opens commit patch', async () => {
		const ed = await vscode.window.showTextDocument(doc);
		ed.selection = new vscode.Selection(1, 0, 1, 0);
		await vscode.commands.executeCommand('revwise.showCommit');
		const shown = await until(() => {
			const d = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
			return d && d.uri.scheme === 'revwise' ? d : undefined;
		});
		assert.ok(shown);
		assert.match(shown.getText(), /second: change line 2/);
		assert.match(shown.getText(), /\+TWO/);
	});

	await check('toggleFileBlame on/off', async () => {
		await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('revwise.toggleFileBlame');
		await sleep(300);
		await vscode.commands.executeCommand('revwise.toggleFileBlame');
	});

	await check('dirty buffer: new line uncommitted, shifted line keeps blame', async () => {
		const ed = await vscode.window.showTextDocument(doc);
		await ed.edit(b => b.insert(new vscode.Position(0, 0), 'zero\n'));
		ed.selection = new vscode.Selection(0, 0, 0, 0);
		const h0 = await until(async () => {
			const t = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', file, doc.lineAt(0).range.end));
			return /Uncommitted/.test(t) ? t : undefined;
		});
		assert.ok(h0, 'uncommitted hover');
		ed.selection = new vscode.Selection(2, 0, 2, 0);
		const h2 = await until(async () => {
			const t = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', file, doc.lineAt(2).range.end));
			return /Bob/.test(t) ? t : undefined;
		});
		assert.ok(h2, 'TWO line still blamed to Bob');
		await vscode.commands.executeCommand('workbench.action.files.revert');
	});

	// ---------------- v0.2 features ----------------
	const api = vscode.extensions.all.find(e => e.id.toLowerCase() === 'revwise.revwise').exports;
	const labels = async (view, node) => {
		const kids = await view.getChildren(node);
		return Promise.all(kids.map(async k => ({ node: k, item: await view.getTreeItem(k) })));
	};
	const labelText = i => (typeof i.item.label === 'string' ? i.item.label : i.item.label.label);

	await check('sidebar views list repo data', async () => {
		const v = api.views;
		const commits = (await labels(v.commits)).map(labelText);
		assert.deepStrictEqual(commits.slice(0, 2), ['merge feature', 'add c on feature'], JSON.stringify(commits));
		assert.deepStrictEqual((await labels(v.branches)).map(labelText), ['main', 'feature']);
		assert.deepStrictEqual((await labels(v.remotes)).map(labelText), ['origin']);
		assert.deepStrictEqual((await labels(v.tags)).map(labelText), ['v1']);
		assert.deepStrictEqual((await labels(v.stashes)).map(labelText), ['wip on c']);
		assert.strictEqual((await labels(v.worktrees)).length, 1);
		assert.deepStrictEqual((await labels(v.contributors)).map(labelText).sort(), ['Alice', 'Bob', 'Carol']);
		const branch = (await labels(v.branches))[1];
		assert.deepStrictEqual((await labels(v.branches, branch.node)).map(labelText).slice(0, 1), ['add c on feature']);
		const stashFiles = (await labels(v.stashes, (await labels(v.stashes))[0].node)).map(labelText);
		assert.deepStrictEqual(stashFiles, ['c.txt']);
	});

	await check('commit node expands to files; file opens diff', async () => {
		const v = api.views;
		const merge = (await labels(v.commits))[0];
		const files = await labels(v.commits, merge.node);
		assert.deepStrictEqual(files.map(labelText), ['c.txt']);
		await vscode.commands.executeCommand(files[0].item.command.command, ...files[0].item.command.arguments);
		const tab = await until(() => {
			const t = vscode.window.tabGroups.activeTabGroup.activeTab;
			return t && t.input instanceof vscode.TabInputTextDiff && /c\.txt/.test(t.label) ? t : undefined;
		});
		assert.ok(tab, 'diff for c.txt');
		const right = await vscode.workspace.openTextDocument(tab.input.modified);
		assert.strictEqual(right.getText().replace(/\r/g, ''), 'carol\n');
	});

	await check('file history view follows active editor', async () => {
		await vscode.window.showTextDocument(doc);
		const items = await until(async () => {
			const l = (await labels(api.views.fileHistory)).map(labelText);
			return l.length === 3 ? l : undefined;
		});
		assert.deepStrictEqual(items, ['rename a to b', 'second: change line 2', 'first commit']);
	});

	await check('line history view tracks selection', async () => {
		await vscode.commands.executeCommand('revwise.lineHistory.focus');
		const ed = await vscode.window.showTextDocument(doc);
		ed.selection = new vscode.Selection(1, 0, 1, 0);
		const items = await until(async () => {
			const l = (await labels(api.views.lineHistory)).map(labelText);
			return l.includes('second: change line 2') ? l : undefined;
		});
		assert.ok(items, 'line 2 history');
		assert.ok(!items.includes('add c on feature'));
	});

	await check('search & compare', async () => {
		const sc = api.views.searchCompare;
		sc.clear();
		await vscode.commands.executeCommand('revwise.searchCommits', 'message', 'change line');
		const search = (await labels(sc))[0];
		assert.strictEqual(labelText(search), '"change line"');
		assert.deepStrictEqual((await labels(sc, search.node)).map(labelText), ['second: change line 2']);
		await vscode.commands.executeCommand('revwise.compareWithHead', { root: repo, refName: 'v1', sha: undefined });
		const cmp = (await labels(sc))[0];
		assert.strictEqual(labelText(cmp), 'v1 ↔ HEAD');
		const groups = await labels(sc, cmp.node);
		assert.deepStrictEqual(groups.map(labelText), ['Commits in HEAD not in v1', 'Commits in v1 not in HEAD', 'Files changed']);
		assert.deepStrictEqual((await labels(sc, groups[0].node)).map(labelText), ['merge feature', 'add c on feature']);
		assert.deepStrictEqual((await labels(sc, groups[2].node)).map(labelText), ['c.txt']);
	});

	await check('commit graph: editor panel loads via webview', async () => {
		await vscode.commands.executeCommand('revwise.showGraph');
		const host = await until(() => [...api.graph.hosts].find(h => h.kind === 'panel' && h.skip > 0 && !h.loading));
		assert.ok(host, 'panel host received rows (webview script ran and posted ready)');
		assert.strictEqual(host.skip, 5);
		assert.ok(host.done);
		assert.strictEqual(host.layout.maxWidth, 2);
		assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab.label, 'Commit Graph');
	});

	await check('commit graph: sidebar webview view loads', async () => {
		await vscode.commands.executeCommand('revwise.graph.focus');
		const host = await until(() => [...api.graph.hosts].find(h => h.kind === 'view' && h.skip > 0 && !h.loading));
		assert.ok(host, 'sidebar host received rows');
	});

	await check('annotations: heatmap / changes / blame toggle and clear', async () => {
		const ed = await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('revwise.toggleHeatmap');
		assert.strictEqual(api.annotations.modeOf(ed.document), 'heatmap');
		await vscode.commands.executeCommand('revwise.toggleChanges');
		assert.strictEqual(api.annotations.modeOf(ed.document), 'changes');
		await vscode.commands.executeCommand('revwise.toggleFileBlame');
		assert.strictEqual(api.annotations.modeOf(ed.document), 'blame');
		await vscode.commands.executeCommand('revwise.clearAnnotations');
		assert.strictEqual(api.annotations.modeOf(ed.document), undefined);
	});

	await check('revision navigation: previous, previous, next', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.window.showTextDocument(doc);
		const diffTab = async re =>
			until(() => {
				const t = vscode.window.tabGroups.activeTabGroup.activeTab;
				return t && t.input instanceof vscode.TabInputTextDiff && re.test(t.label) ? t : undefined;
			});
		await vscode.commands.executeCommand('revwise.openPreviousRevision');
		const t1 = await diffTab(/b\.txt \([0-9a-f]{7}\) ↔ \([0-9a-f]{7}\)/);
		assert.ok(t1, 'diff at newest revision');
		const r1 = JSON.parse(t1.input.modified.query).ref;
		await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'revwise');
		await vscode.commands.executeCommand('revwise.openPreviousRevision');
		const t2 = await until(async () => {
			const t = await diffTab(/b\.txt/);
			return t && JSON.parse(t.input.modified.query).ref !== r1 ? t : undefined;
		});
		assert.ok(t2, 'stepped back');
		const left = await vscode.workspace.openTextDocument(t2.input.original);
		assert.strictEqual(left.getText().replace(/\r/g, ''), 'one\ntwo\nthree\n');
		await until(() => vscode.window.activeTextEditor?.document.uri.toString() === t2.input.modified.toString());
		await vscode.commands.executeCommand('revwise.openNextRevision');
		const t3 = await until(async () => {
			const t = await diffTab(/b\.txt/);
			return t && JSON.parse(t.input.modified.query).ref === r1 ? t : undefined;
		});
		assert.ok(t3, 'stepped forward');
	});

	await check('remote URLs: file and commit', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const ed = await vscode.window.showTextDocument(doc);
		ed.selection = new vscode.Selection(0, 0, 1, 3);
		await vscode.commands.executeCommand('revwise.copyRemoteFileUrl');
		assert.match(await vscode.env.clipboard.readText(), /^https:\/\/github\.com\/owner\/repo\/blob\/[0-9a-f]{40}\/b\.txt#L1-L2$/);
	});

	await check('checkout branch via tree node, then back', async () => {
		const branches = await labels(api.views.branches);
		const feature = branches.find(b => labelText(b) === 'feature');
		await vscode.commands.executeCommand('revwise.checkout', feature.node);
		assert.strictEqual((await require('../src/git').currentBranch(repo)), 'feature');
		await vscode.commands.executeCommand('revwise.checkout', { root: repo, refName: 'main' });
		assert.strictEqual((await require('../src/git').currentBranch(repo)), 'main');
	});

	await check('stash apply via tree node', async () => {
		const stash = (await labels(api.views.stashes))[0];
		await vscode.commands.executeCommand('revwise.stashApply', stash.node);
		assert.strictEqual(fs.readFileSync(path.join(repo, 'c.txt'), 'utf8').replace(/\r/g, ''), 'carol\nstashed\n');
	});

	// ---------------- v0.3 differentiators ----------------
	const { execFileSync } = require('child_process');
	const os = require('os');
	const w = vscode.window;
	const originals = {};
	const stub = (name, fn) => {
		if (!(name in originals)) originals[name] = w[name];
		w[name] = fn;
	};
	const restore = () => {
		for (const [k, v] of Object.entries(originals)) w[k] = v;
	};
	const r2 = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'revwise-int2-')));
	const g2 = (...a) => execFileSync('git', a, { cwd: r2, encoding: 'utf8' }).trim();
	g2('init', '-q', '-b', 'main');
	g2('config', 'user.name', 'Dana');
	g2('config', 'user.email', 'dana@example.com');
	g2('config', 'commit.gpgsign', 'false');
	g2('config', 'core.autocrlf', 'false');
	for (const n of ['one', 'two', 'three', 'four']) {
		fs.writeFileSync(path.join(r2, `${n}.txt`), `${n}\n`);
		g2('add', '.');
		g2('commit', '-q', '-m', `add ${n}`);
	}
	const subjects2 = () => g2('log', '--format=%s').split('\n');
	const shas2 = () => g2('rev-list', '--reverse', 'HEAD').split('\n');
	const doc2 = await vscode.workspace.openTextDocument(path.join(r2, 'one.txt'));
	await vscode.window.showTextDocument(doc2);
	await until(() => api.repos.active === r2);

	await check('reword older commit from command, then undo restores it', async () => {
		const before = g2('rev-parse', 'HEAD');
		stub('showInputBox', async () => 'Add TWO (reworded)');
		await vscode.commands.executeCommand('revwise.rewordCommit', { root: r2, sha: shas2()[1] });
		assert.deepStrictEqual(subjects2(), ['add four', 'add three', 'Add TWO (reworded)', 'add one']);
		const [entry] = api.journal.list(r2);
		assert.match(entry.label, /^Reword/);
		stub('showWarningMessage', async (_m, _o, ...items) => items[0]);
		await vscode.commands.executeCommand('revwise.undo');
		assert.strictEqual(g2('rev-parse', 'HEAD'), before);
		assert.strictEqual(api.journal.list(r2).length, 0);
		restore();
	});

	await check('squash two non-adjacent commits (graph-style shas arg)', async () => {
		const s = shas2();
		stub('showInputBox', async () => 'two+four');
		await vscode.commands.executeCommand('revwise.squashCommits', { root: r2, sha: s[3], shas: [s[3], s[1]] });
		assert.deepStrictEqual(subjects2(), ['add three', 'two+four', 'add one']);
		restore();
	});

	await check('multi-select tree nodes: drop + undo; combined changes', async () => {
		const s = shas2();
		const nodes = s.slice(1).map(sha => ({ root: r2, sha, commit: { sha } }));
		stub('showWarningMessage', async (_m, _o, ...items) => items[0]);
		await vscode.commands.executeCommand('revwise.dropCommits', nodes[0], [nodes[0], nodes[1]]);
		assert.deepStrictEqual(subjects2(), ['add one']);
		await vscode.commands.executeCommand('revwise.undo');
		assert.deepStrictEqual(subjects2(), ['add three', 'two+four', 'add one']);
		restore();
		const sc = api.views.searchCompare;
		sc.clear();
		const now = shas2();
		await vscode.commands.executeCommand('revwise.showCombinedChanges', nodes[0], [
			{ root: r2, sha: now[1] },
			{ root: r2, sha: now[2] },
		]);
		const cmp = (await labels(sc))[0];
		const files = (await labels(sc, (await labels(sc, cmp.node))[2].node)).map(labelText).sort();
		assert.deepStrictEqual(files, ['four.txt', 'three.txt', 'two.txt']);
	});

	await check('interactive rebase plan: edit + start', async () => {
		const s = shas2();
		await vscode.commands.executeCommand('revwise.rebase.editPlan', { root: r2, sha: s[1] });
		const ed = await until(() => (/git-rebase-todo$/.test(vscode.window.activeTextEditor?.document.fileName || '') ? vscode.window.activeTextEditor : undefined));
		assert.ok(ed, 'plan opened');
		const lines = ed.document.getText().split('\n').filter(l => /^pick /.test(l));
		assert.strictEqual(lines.length, 2);
		await ed.edit(b => b.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), `${lines[1]}\n${lines[0].replace(/^pick (\w+) .*/, 'reword $1 TWO+FOUR')}\n`));
		await vscode.commands.executeCommand('revwise.rebase.start');
		assert.deepStrictEqual(subjects2(), ['TWO+FOUR', 'add three', 'add one']);
	});

	await check('cherry-pick many onto another branch', async () => {
		const s = shas2();
		g2('switch', '-q', '-c', 'side', s[0]);
		stub('showWarningMessage', async (_m, _o, ...items) => items[0]);
		await vscode.commands.executeCommand('revwise.cherryPick', { root: r2, sha: s[2], shas: [s[2], s[1]] });
		assert.deepStrictEqual(subjects2(), ['TWO+FOUR', 'add three', 'add one']);
		restore();
		g2('switch', '-q', 'main');
	});

	await check('changelists: auto-assign, move, commit only that list (incl. untracked + deletion)', async () => {
		const cl = api.changelists;
		fs.appendFileSync(path.join(r2, 'one.txt'), 'more\n');
		fs.writeFileSync(path.join(r2, 'brand-new.txt'), 'new\n');
		fs.unlinkSync(path.join(r2, 'three.txt'));
		fs.appendFileSync(path.join(r2, 'two.txt'), 'keep me uncommitted\n');
		await cl.reload();
		assert.strictEqual(cl.filesIn('default').length, 4);
		const id = await cl.create('Feature X');
		await cl.move(['one.txt', 'brand-new.txt', 'three.txt'], id);
		const lists = await cl.getChildren();
		assert.deepStrictEqual(lists.map(l => l.name), ['Changes', 'Feature X']);
		assert.deepStrictEqual((await cl.getChildren(lists[1])).map(f => f.path).sort(), ['brand-new.txt', 'one.txt', 'three.txt']);
		const item = cl.getTreeItem(lists[1]);
		assert.match(item.description, /^3 files/);
		stub('showInputBox', async () => 'Feature X commit');
		await vscode.commands.executeCommand('revwise.changelists.commit', lists[1]);
		restore();
		assert.strictEqual(subjects2()[0], 'Feature X commit');
		assert.deepStrictEqual(g2('show', '--name-status', '--format=', 'HEAD').split('\n').sort(), ['A\tbrand-new.txt', 'D\tthree.txt', 'M\tone.txt']);
		assert.strictEqual(execFileSync('git', ['status', '--porcelain'], { cwd: r2, encoding: 'utf8' }), ' M two.txt\n', 'other list untouched');
		await cl.reload();
		assert.deepStrictEqual(cl.filesIn('default').map(f => f.path), ['two.txt']);
		assert.strictEqual(cl.filesIn(id).length, 0);
		await cl.setActive(id);
		fs.writeFileSync(path.join(r2, 'later.txt'), 'x\n');
		await cl.reload();
		assert.deepStrictEqual(cl.filesIn(id).map(f => f.path), ['later.txt'], 'new files go to the active list');
		await cl.stash(id);
		assert.ok(!fs.existsSync(path.join(r2, 'later.txt')));
		assert.match(g2('stash', 'list'), /Feature X/);
	});

	await check('patches: create from commit, apply to working tree, undo apply', async () => {
		stub('showInformationMessage', async () => undefined);
		await vscode.commands.executeCommand('revwise.createPatchFromCommits', { root: r2, sha: shas2().pop() });
		const pdoc = await until(() => (vscode.window.activeTextEditor?.document.languageId === 'diff' ? vscode.window.activeTextEditor.document : undefined));
		assert.ok(pdoc && /Subject: \[PATCH\] Feature X commit/.test(pdoc.getText()));
		restore();
		g2('checkout', '-q', '--', '.');
		const p = path.join(r2, '..', `gs-${Date.now()}.patch`);
		fs.writeFileSync(p, 'diff --git a/four.txt b/four.txt\n--- a/four.txt\n+++ b/four.txt\n@@ -1 +1,2 @@\n four\n+patched\n');
		await vscode.commands.executeCommand('revwise.applyPatch', vscode.Uri.file(p));
		assert.strictEqual(fs.readFileSync(path.join(r2, 'four.txt'), 'utf8'), 'four\npatched\n');
		stub('showWarningMessage', async (_m, _o, ...items) => items[0]);
		await vscode.commands.executeCommand('revwise.undo');
		restore();
		assert.strictEqual(fs.readFileSync(path.join(r2, 'four.txt'), 'utf8'), 'four\n');
		fs.unlinkSync(p);
	});

	await check('undo & reflog view: deleted branch restorable; reflog listed', async () => {
		g2('branch', 'temp-branch');
		await api.repos.refresh(r2);
		const branchNode = (await labels(api.views.branches)).find(b => labelText(b) === 'temp-branch');
		stub('showWarningMessage', async (_m, _o, ...items) => items[0]);
		await vscode.commands.executeCommand('revwise.deleteBranch', branchNode.node);
		assert.doesNotMatch(g2('branch'), /temp-branch/);
		const groups = await labels(api.views.undo);
		assert.deepStrictEqual(groups.map(labelText), ['Revwise Operations', 'HEAD Reflog']);
		const ops = await labels(api.views.undo, groups[0].node);
		assert.strictEqual(labelText(ops[0]), 'Delete branch temp-branch');
		await vscode.commands.executeCommand('revwise.undoEntry', ops[0].node);
		assert.match(g2('branch'), /temp-branch/);
		restore();
		const reflog = await labels(api.views.undo, groups[1].node);
		assert.ok(reflog.length > 3 && /HEAD@\{0\}/.test(reflog[0].item.description));
	});

	await check('branch cleanup: merged preselected, protected/current excluded, deletions journaled', async () => {
		g2('branch', 'merged-a');
		g2('switch', '-q', '-c', 'wip-unmerged');
		fs.writeFileSync(path.join(r2, 'wip.txt'), 'w\n');
		g2('add', '.');
		g2('commit', '-q', '-m', 'wip');
		g2('switch', '-q', 'main');
		let offered;
		stub('createQuickPick', () => {
			const handlers = {};
			const qp = {
				items: [], selectedItems: [], buttons: [], busy: false,
				onDidAccept: f => (handlers.accept = f), onDidHide: f => (handlers.hide = f), onDidTriggerButton: () => {},
				show() {
					setTimeout(async () => {
						await until(() => qp.items.length && !qp.busy);
						offered = qp.items.map(i => [i.branch.name, qp.selectedItems.includes(i)]);
						handlers.accept();
					}, 50);
				},
				hide() { handlers.hide?.(); }, dispose() {},
			};
			return qp;
		});
		stub('showWarningMessage', async (_m, _o, ...items) => items[0]);
		await vscode.commands.executeCommand('revwise.cleanupBranches', { root: r2 });
		restore();
		const map = Object.fromEntries(offered);
		assert.strictEqual(map['merged-a'], true);
		assert.strictEqual(map['temp-branch'], true);
		assert.ok(!('side' in map), 'cherry-picked copies are not "merged"; recent unmerged branches are not offered');
		assert.ok(!('main' in map), 'protected/current never offered');
		assert.ok(!('wip-unmerged' in map), 'recent unmerged branch not offered');
		assert.doesNotMatch(g2('branch'), /merged-a|temp-branch/);
		assert.ok(api.journal.list(r2).some(e => e.label === 'Delete branch merged-a'));
	});

	await check('visual file history panel receives commit stats', async () => {
		await vscode.window.showTextDocument(doc2);
		await vscode.commands.executeCommand('revwise.showVisualHistory');
		const host = await until(() => [...api.visualHistory.hosts].find(h => h.kind === 'panel' && h.commits?.length));
		assert.ok(host, 'panel loaded');
		assert.deepStrictEqual(host.commits.map(c => c.summary), ['Feature X commit', 'add one']);
		assert.strictEqual(host.commits[0].adds, 1);
	});

	await check('blame hover shows git notes', async () => {
		const sha = g2('rev-parse', 'HEAD');
		g2('notes', 'add', '-m', 'reviewed by QA', sha);
		const ed = await vscode.window.showTextDocument(doc2);
		ed.selection = new vscode.Selection(1, 0, 1, 0);
		const end = doc2.lineAt(1).range.end;
		const text = await until(async () => {
			const t = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', doc2.uri, end));
			return /reviewed by QA/.test(t) ? t : undefined;
		});
		assert.ok(text, 'note in hover');
		assert.match(text, /command:revwise\.rewordCommit/);
	});

	restore();
	fs.writeFileSync(process.env.REVWISE_RESULTS, JSON.stringify(results, null, 2));
	const failed = results.filter(r => !r.ok);
	if (failed.length) throw new Error(`${failed.length} check(s) failed`);
}

module.exports = { run };
