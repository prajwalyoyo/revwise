'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/git');
const { GraphLayout } = require('../src/graphLayout');
const remote = require('../src/remote');

test('GraphLayout: linear, branch and merge', () => {
	// History (newest first):  M merges F into A2;  F branches from A1
	//   M(A2,F) ; F(A1) ; A2(A1) ; A1()
	const l = new GraphLayout();
	const m = l.add({ sha: 'M', parents: ['A2', 'F'] });
	assert.strictEqual(m.col, 0);
	assert.deepStrictEqual(m.down.map(d => d.to), [0, 1]);
	const f = l.add({ sha: 'F', parents: ['A1'] });
	assert.strictEqual(f.col, 1);
	assert.deepStrictEqual(f.pass.map(p => p.col), [0]);
	assert.deepStrictEqual(f.down.map(d => d.to), [1]);
	const a2 = l.add({ sha: 'A2', parents: ['A1'] });
	assert.strictEqual(a2.col, 0);
	// A1 is already expected on lane 1, so A2 links into it rather than opening a new lane.
	assert.deepStrictEqual(a2.down.map(d => d.to), [1]);
	const a1 = l.add({ sha: 'A1', parents: [] });
	assert.strictEqual(a1.col, 1);
	assert.deepStrictEqual(a1.up.map(u => u.from).sort(), [1]);
	assert.strictEqual(l.lanes.length, 0);
	assert.strictEqual(l.maxWidth, 2);
});

test('GraphLayout: two tips converging and lane reuse', () => {
	const l = new GraphLayout();
	const x = l.add({ sha: 'X', parents: ['B'] });
	const y = l.add({ sha: 'Y', parents: ['B'] });
	assert.strictEqual(x.col, 0);
	assert.strictEqual(y.col, 1);
	assert.deepStrictEqual(y.down.map(d => d.to), [0]);
	const b = l.add({ sha: 'B', parents: ['C'] });
	assert.strictEqual(b.col, 0);
	const z = l.add({ sha: 'Z', parents: ['C'] });
	assert.strictEqual(z.col, 1, 'freed column is reused');
	assert.strictEqual(x.color === b.color, true);
});

test('remote URL parsing and links', () => {
	const gh = remote.parseRemoteUrl('git@github.com:owner/repo.git');
	assert.deepStrictEqual(gh, { kind: 'github', base: 'https://github.com/owner/repo' });
	assert.strictEqual(remote.parseRemoteUrl('https://user@github.com/owner/repo.git').base, 'https://github.com/owner/repo');
	assert.strictEqual(remote.parseRemoteUrl('ssh://git@ghe.corp.com:2222/team/x.git').base, 'https://ghe.corp.com/team/x');
	assert.strictEqual(remote.fileUrl(gh, 'main', 'src/a b.js', 3, 5), 'https://github.com/owner/repo/blob/main/src/a%20b.js#L3-L5');
	assert.strictEqual(remote.commitUrl(gh, 'abc'), 'https://github.com/owner/repo/commit/abc');

	const gl = remote.parseRemoteUrl('git@gitlab.com:group/sub/proj.git');
	assert.strictEqual(gl.kind, 'gitlab');
	assert.strictEqual(remote.fileUrl(gl, 'dev', 'a.js', 2), 'https://gitlab.com/group/sub/proj/-/blob/dev/a.js#L2');
	assert.strictEqual(remote.branchUrl(gl, 'feat/x'), 'https://gitlab.com/group/sub/proj/-/tree/feat/x');

	const bb = remote.parseRemoteUrl('https://bitbucket.org/team/repo.git');
	assert.strictEqual(remote.fileUrl(bb, 'main', 'a.js', 1, 4), 'https://bitbucket.org/team/repo/src/main/a.js#lines-1:4');
	assert.strictEqual(remote.commitUrl(bb, 'abc'), 'https://bitbucket.org/team/repo/commits/abc');

	const az = remote.parseRemoteUrl('git@ssh.dev.azure.com:v3/org/proj/repo');
	assert.deepStrictEqual(az, { kind: 'azure', base: 'https://dev.azure.com/org/proj/_git/repo' });
	assert.strictEqual(remote.parseRemoteUrl('https://org@dev.azure.com/org/proj/_git/repo').base, 'https://dev.azure.com/org/proj/_git/repo');
	const sha = 'a'.repeat(40);
	assert.strictEqual(
		remote.fileUrl(az, sha, 'src/a.js', 2),
		`https://dev.azure.com/org/proj/_git/repo?path=%2Fsrc%2Fa.js&version=GC${sha}&line=2&lineEnd=3&lineStartColumn=1&lineEndColumn=1&lineStyle=plain`,
	);
	assert.match(remote.branchUrl(az, 'main'), /version=GBmain$/);
	assert.strictEqual(remote.parseRemoteUrl(''), undefined);
});

test('parsers: refs, worktrees, shortlog, name-status, -U0', () => {
	assert.deepStrictEqual(git.parseRefs('HEAD -> main, origin/main, tag: v1, origin/HEAD'), [
		{ type: 'head', name: 'HEAD' },
		{ type: 'branch', name: 'main', current: true },
		{ type: 'remote', name: 'origin/main' },
		{ type: 'tag', name: 'v1' },
	]);
	assert.deepStrictEqual(
		git.parseRefs('HEAD -> refs/heads/feature/x, refs/heads/fix/y, refs/remotes/origin/feature/x, tag: refs/tags/rel/1.0, refs/stash'),
		[
			{ type: 'head', name: 'HEAD' },
			{ type: 'branch', name: 'feature/x', current: true },
			{ type: 'branch', name: 'fix/y' },
			{ type: 'remote', name: 'origin/feature/x' },
			{ type: 'tag', name: 'rel/1.0' },
		],
	);
	const wts = git.parseWorktrees('worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\nlocked\n');
	assert.strictEqual(wts.length, 2);
	assert.strictEqual(wts[0].branch, 'main');
	assert.ok(wts[1].detached && wts[1].locked);
	assert.deepStrictEqual(git.parseShortlog('    12\tAlice <a@x>\n     3\tBob <b@x>\n'), [
		{ count: 12, name: 'Alice', email: 'a@x' },
		{ count: 3, name: 'Bob', email: 'b@x' },
	]);
	assert.deepStrictEqual(git.parseNameStatus('M\ta.txt\nR087\told.txt\tnew.txt\n'), [
		{ status: 'M', path: 'a.txt' },
		{ status: 'R', originalPath: 'old.txt', path: 'new.txt' },
	]);
	assert.deepStrictEqual(git.parseUnifiedZero('@@ -0,0 +1,2 @@\n+a\n@@ -5 +7 @@\n@@ -9,2 +10,0 @@\n'), [
		{ type: 'added', start: 1, count: 2 },
		{ type: 'modified', start: 7, count: 1 },
		{ type: 'deleted', start: 10, count: 0 },
	]);
});

async function makeRepo() {
	const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'revwise-v-')));
	const g = (...a) => git.run(a, { cwd: dir });
	const write = (f, s) => fs.writeFileSync(path.join(dir, f), s);
	await g('init', '-q', '-b', 'main');
	await g('config', 'user.name', 'Alice');
	await g('config', 'user.email', 'alice@example.com');
	await g('config', 'commit.gpgsign', 'false');
	await g('config', 'tag.gpgsign', 'false');
	write('a.txt', '1\n2\n3\n4\n5\n');
	await g('add', '.');
	await g('commit', '-q', '-m', 'init');
	await g('tag', 'v1');
	await g('switch', '-q', '-c', 'feature');
	await g('config', 'user.name', 'Bob');
	await g('config', 'user.email', 'bob@example.com');
	write('b.txt', 'feature\n');
	await g('add', '.');
	await g('commit', '-q', '-m', 'add feature file');
	await g('switch', '-q', 'main');
	await g('config', 'user.name', 'Alice');
	await g('config', 'user.email', 'alice@example.com');
	write('a.txt', '1\nTWO\n3\n4\n5\n');
	await g('commit', '-q', '-am', 'change line two');
	await g('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
	await g('tag', '-a', 'v2', '-m', 'release 2');
	await g('remote', 'add', 'origin', 'git@github.com:owner/repo.git');
	write('a.txt', '1\nTWO\n3\n4\nFIVE\n');
	await g('stash', 'push', '-q', '-m', 'wip five');
	return dir;
}

test('git queries against a repo with branches, merge, tags and stash', async () => {
	const dir = await makeRepo();
	try {
		const graph = await git.graphLog(dir, { limit: 50 });
		assert.deepStrictEqual(graph.map(c => c.summary), ['merge feature', 'change line two', 'add feature file', 'init']);
		assert.strictEqual(graph[0].parents.length, 2);
		assert.ok(graph[0].refs.some(r => r.type === 'branch' && r.name === 'main' && r.current));
		assert.ok(graph[0].refs.some(r => r.type === 'tag' && r.name === 'v2'));
		assert.ok(!graph.some(c => /wip five/.test(c.summary)), 'stash commits excluded from graph');
		const layout = new GraphLayout();
		const rows = graph.map(c => layout.add(c));
		assert.strictEqual(layout.maxWidth, 2);
		assert.strictEqual(rows[3].col, 0);

		const paged = await git.graphLog(dir, { skip: 2, limit: 1 });
		assert.strictEqual(paged[0].summary, 'add feature file');

		const branches = await git.branches(dir);
		const main = branches.find(b => b.name === 'main');
		assert.ok(main.current && !main.remote);
		assert.ok(branches.find(b => b.name === 'feature'));

		assert.deepStrictEqual(await git.remotes(dir), [
			{ name: 'origin', url: 'git@github.com:owner/repo.git', pushUrl: 'git@github.com:owner/repo.git' },
		]);

		const tags = await git.tags(dir);
		assert.deepStrictEqual(tags.map(t => t.name).sort(), ['v1', 'v2']);
		const v2 = tags.find(t => t.name === 'v2');
		assert.ok(v2.annotated);
		assert.strictEqual(v2.sha, graph[0].sha, 'annotated tag peeled to commit');

		const stashes = await git.stashes(dir);
		assert.strictEqual(stashes.length, 1);
		assert.strictEqual(stashes[0].ref, 'stash@{0}');
		assert.strictEqual(stashes[0].message, 'wip five');
		assert.strictEqual(stashes[0].branch, 'main');
		assert.deepStrictEqual(await git.stashFiles(dir, 'stash@{0}'), [{ status: 'M', path: 'a.txt' }]);

		const wts = await git.worktrees(dir);
		assert.strictEqual(wts.length, 1);
		assert.strictEqual(wts[0].branch, 'main');

		const contributors = await git.contributors(dir);
		assert.deepStrictEqual(
			contributors.map(c => [c.name, c.count]),
			[['Alice', 2], ['Bob', 1]],
		);

		assert.deepStrictEqual(await git.commitFiles(dir, graph[0].sha), [{ status: 'A', path: 'b.txt' }]);
		assert.deepStrictEqual(await git.commitFiles(dir, graph[3].sha), [{ status: 'A', path: 'a.txt' }]);
		assert.deepStrictEqual(await git.diffFiles(dir, 'v1', 'main'), [
			{ status: 'M', path: 'a.txt' },
			{ status: 'A', path: 'b.txt' },
		]);

		const lines = await git.lineLog(dir, path.join(dir, 'a.txt'), 2, 2);
		assert.deepStrictEqual(lines.map(c => c.summary), ['change line two', 'init']);

		assert.deepStrictEqual((await git.searchCommits(dir, 'message', 'FEATURE')).map(c => c.summary).sort(), ['add feature file', 'merge feature']);
		assert.deepStrictEqual((await git.searchCommits(dir, 'author', 'bob')).map(c => c.summary), ['add feature file']);
		assert.deepStrictEqual((await git.searchCommits(dir, 'sha', graph[1].sha.slice(0, 8))).map(c => c.summary), ['change line two']);
		assert.deepStrictEqual((await git.searchCommits(dir, 'file', 'b.t')).map(c => c.summary), ['add feature file']);
		assert.deepStrictEqual((await git.searchCommits(dir, 'changes', 'TWO')).map(c => c.summary), ['change line two']);
		assert.deepStrictEqual(await git.searchCommits(dir, 'sha', 'deadbeefnotthere'), []);

		fs.writeFileSync(path.join(dir, 'a.txt'), '0\n1\nTWO\n3\n5\n');
		const hunks = await git.diffHunks(dir, 'HEAD', path.join(dir, 'a.txt'));
		assert.deepStrictEqual(hunks.map(h => h.type), ['added', 'deleted']);

		assert.strictEqual(await git.currentBranch(dir), 'main');
		assert.strictEqual(await git.revParse(dir, 'HEAD'), graph[0].sha);
		assert.ok(fs.existsSync(path.join(await git.gitDir(dir), 'HEAD')));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
