'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/git');
const rw = require('../src/rewrite');

async function repo() {
	const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'revwise-rw-')));
	const g = (...a) => git.run(a, { cwd: dir });
	await g('init', '-q', '-b', 'main');
	await g('config', 'user.name', 'T');
	await g('config', 'user.email', 't@x');
	await g('config', 'commit.gpgsign', 'false');
	await g('config', 'core.autocrlf', 'false');
	for (const n of ['a', 'b', 'c', 'd']) {
		fs.writeFileSync(path.join(dir, `${n}.txt`), `${n}\n`);
		await g('add', '.');
		await g('commit', '-q', '-m', `add ${n}`, '-m', `body of ${n}`);
	}
	const shas = (await g('rev-list', '--reverse', 'HEAD')).trim().split('\n');
	return { dir, g, shas };
}
const subjects = async g => (await g('log', '--format=%s')).trim().split('\n');
const cleanup = dir => fs.rmSync(dir, { recursive: true, force: true });

test('reword an older commit keeps later commits and files', async () => {
	const { dir, g, shas } = await repo();
	try {
		fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted\n');
		await g('add', 'dirty.txt');
		await rw.reword(dir, shas[1], 'Add B (reworded)\n\nnew body');
		assert.deepStrictEqual(await subjects(g), ['add d', 'add c', 'Add B (reworded)', 'add a']);
		assert.strictEqual((await g('log', '-1', '--format=%B', 'HEAD~2')).trim(), 'Add B (reworded)\n\nnew body');
		assert.strictEqual((await g('rev-parse', 'HEAD~3')).trim(), shas[0], 'commits before the target are untouched');
		assert.ok(fs.existsSync(path.join(dir, 'dirty.txt')), 'autostash restored uncommitted work');
		assert.strictEqual(await git.sequencerState(dir), undefined);
	} finally {
		cleanup(dir);
	}
});

test('reword HEAD and root commit', async () => {
	const { dir, g, shas } = await repo();
	try {
		await rw.reword(dir, shas[3], 'D!');
		assert.strictEqual((await subjects(g))[0], 'D!');
		await rw.reword(dir, shas[0], 'root!');
		assert.deepStrictEqual(await subjects(g), ['D!', 'add c', 'add b', 'root!']);
	} finally {
		cleanup(dir);
	}
});

test('squash non-adjacent commits with a new message, fixup without, drop', async () => {
	const { dir, g, shas } = await repo();
	try {
		await rw.squash(dir, [shas[3], shas[1]], 'b+d together');
		assert.deepStrictEqual(await subjects(g), ['add c', 'b+d together', 'add a']);
		assert.deepStrictEqual(
			(await g('show', '--name-only', '--format=', 'HEAD~1')).trim().split('\n').sort(),
			['b.txt', 'd.txt'],
		);
		const now = (await g('rev-list', '--reverse', 'HEAD')).trim().split('\n');
		await rw.squash(dir, [now[0], now[1]]);
		assert.deepStrictEqual(await subjects(g), ['add c', 'add a']);
		await rw.drop(dir, [(await g('rev-parse', 'HEAD')).trim()]);
		assert.deepStrictEqual(await subjects(g), ['add a']);
		assert.ok(!fs.existsSync(path.join(dir, 'c.txt')));
	} finally {
		cleanup(dir);
	}
});

test('custom plan: reorder, reword subject (keeping body), drop', async () => {
	const { dir, g, shas } = await repo();
	try {
		const { base, text } = await rw.planText(dir, shas[1]);
		assert.strictEqual(base, shas[0]);
		const lines = text.split('\n').filter(l => /^pick /.test(l));
		assert.strictEqual(lines.length, 3);
		const [b, c, d] = lines;
		const edited = [d, c.replace(/^pick (\w+) .*/, 'reword $1 C renamed'), b.replace(/^pick/, 'drop')].join('\n') + '\n# comment\n';
		await rw.applyPlan(dir, base, edited);
		assert.deepStrictEqual(await subjects(g), ['C renamed', 'add d', 'add a']);
		assert.strictEqual((await g('log', '-1', '--format=%B')).trim(), 'C renamed\n\nbody of c');
	} finally {
		cleanup(dir);
	}
});

test('conflicting rewrite pauses; abort restores; validation errors', async () => {
	const { dir, g, shas } = await repo();
	try {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'a2\n');
		await g('commit', '-q', '-am', 'edit a');
		fs.writeFileSync(path.join(dir, 'a.txt'), 'a3\n');
		await g('commit', '-q', '-am', 'edit a again');
		const all = (await g('rev-list', '--reverse', 'HEAD')).trim().split('\n');
		const head = all[all.length - 1];
		await assert.rejects(rw.drop(dir, [all[4]]), e => e.state === 'rebase');
		assert.strictEqual(await git.sequencerState(dir), 'rebase');
		await assert.rejects(rw.reword(dir, all[1], 'x'), /already in progress/);
		assert.strictEqual(await rw.abortOp(dir), 'rebase');
		assert.strictEqual((await g('rev-parse', 'HEAD')).trim(), head);

		await g('switch', '-q', '-c', 'side', shas[1]);
		await assert.rejects(rw.reword(dir, shas[3], 'x'), /isn't on the current branch/);
		fs.writeFileSync(path.join(dir, 'side.txt'), 'side\n');
		await g('add', '.');
		await g('commit', '-q', '-m', 'side work');
		await g('switch', '-q', 'main');
		await g('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
		await assert.rejects(rw.reword(dir, shas[2], 'x'), /merge commits/);
	} finally {
		cleanup(dir);
	}
});

test('sortOldestFirst uses ancestry even when timestamps tie (incl. root commit)', async () => {
	const { dir, g, shas } = await repo();
	try {
		// Recommit everything with one identical timestamp, like a fast rebase does.
		await git.run(['filter-branch', '-f', '--env-filter', 'export GIT_COMMITTER_DATE="1700000000 +0000"', 'HEAD'], {
			cwd: dir,
			env: { FILTER_BRANCH_SQUELCH_WARNING: '1' },
		});
		const now = (await g('rev-list', '--reverse', 'HEAD')).trim().split('\n');
		assert.strictEqual(new Set((await g('log', '--format=%ct')).trim().split('\n')).size, 1, 'all timestamps equal');
		for (const pick of [[now[3], now[1]], [now[2], now[1]], [now[3], now[0], now[2]]]) {
			const expected = now.filter(s => pick.includes(s));
			assert.deepStrictEqual(await git.sortOldestFirst(dir, pick), expected);
		}
		await rw.drop(dir, [now[1], now[2]]);
		assert.deepStrictEqual(await subjects(g), ['add d', 'add a']);
		void shas;
	} finally {
		cleanup(dir);
	}
});

test('cherry-pick many (oldest first) and conflict → continue/skip', async () => {
	const { dir, g, shas } = await repo();
	try {
		await g('switch', '-q', '-c', 'other', shas[0]);
		await rw.cherryPick(dir, [shas[3], shas[2]]);
		assert.deepStrictEqual(await subjects(g), ['add d', 'add c', 'add a']);
		fs.writeFileSync(path.join(dir, 'b.txt'), 'conflict\n');
		await g('add', '.');
		await g('commit', '-q', '-m', 'b differently');
		await assert.rejects(rw.cherryPick(dir, [shas[1]]), e => e.state === 'cherry-pick');
		fs.writeFileSync(path.join(dir, 'b.txt'), 'resolved\n');
		await g('add', 'b.txt');
		assert.strictEqual(await rw.continueOp(dir), 'cherry-pick');
		assert.strictEqual((await subjects(g))[0], 'add b');
		assert.strictEqual(await git.sequencerState(dir), undefined);
	} finally {
		cleanup(dir);
	}
});
