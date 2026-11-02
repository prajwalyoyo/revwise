'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/git');

const mk = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'revwise-d-')));
async function init(dir, name = 'Alice', email = 'alice@x') {
	const g = (...a) => git.run(a, { cwd: dir });
	await g('init', '-q', '-b', 'main');
	await g('config', 'user.name', name);
	await g('config', 'user.email', email);
	await g('config', 'commit.gpgsign', 'false');
	await g('config', 'core.autocrlf', 'false');
	return g;
}
const as = async (g, name, email) => {
	await g('config', 'user.name', name);
	await g('config', 'user.email', email);
};

test('blame: ignore-revs file skips a formatting commit; -M follows moved lines', async () => {
	const dir = mk();
	try {
		const g = await init(dir);
		const file = path.join(dir, 'f.js');
		fs.writeFileSync(file, 'function a(){return 1}\nfunction b(){return 2}\n');
		await g('add', '.');
		await g('commit', '-q', '-m', 'original');
		await as(g, 'Formatter', 'fmt@x');
		fs.writeFileSync(file, 'function a() { return 1 }\nfunction b() { return 2 }\n');
		await g('commit', '-q', '-am', 'reformat');
		const fmtSha = (await g('rev-parse', 'HEAD')).trim();

		let r = await git.blame(dir, file);
		assert.strictEqual(r.commits.get(r.lines[0].sha).author, 'Formatter');
		const ignore = path.join(dir, '.git-blame-ignore-revs');
		fs.writeFileSync(ignore, `# formatting\n${fmtSha}\n`);
		r = await git.blame(dir, file, { ignoreRevsFile: ignore });
		assert.strictEqual(r.commits.get(r.lines[0].sha).author, 'Alice', 'formatting commit skipped');
		fs.writeFileSync(ignore, 'not-a-sha\n');
		r = await git.blame(dir, file, { ignoreRevsFile: ignore });
		assert.strictEqual(r.lines.length, 2, 'invalid ignore file falls back to plain blame');

		await as(g, 'Mover', 'mv@x');
		const big = Array.from({ length: 12 }, (_, i) => `const value${i} = compute(${i}) + offset * ${i};`);
		fs.writeFileSync(file, big.join('\n') + '\nconst tail = 1;\n');
		await as(g, 'Alice', 'alice@x');
		await g('commit', '-q', '-am', 'block');
		await as(g, 'Mover', 'mv@x');
		fs.writeFileSync(file, 'const tail = 1;\n' + big.join('\n') + '\n');
		await g('commit', '-q', '-am', 'move block below');
		const plain = await git.blame(dir, file);
		const moved = await git.blame(dir, file, { detectMoves: 'file' });
		const authorAt = (res, i) => res.commits.get(res.lines[i].sha).author;
		assert.ok([...Array(12).keys()].some(i => authorAt(plain, i + 1) === 'Mover') || authorAt(plain, 0) === 'Mover');
		assert.strictEqual(authorAt(moved, 5), 'Alice', '-M attributes moved lines to their author');
		assert.strictEqual(await git.notes(dir, fmtSha), undefined);
		await g('notes', 'add', '-m', 'formatting only', fmtSha);
		assert.strictEqual(await git.notes(dir, fmtSha), 'formatting only');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('status v2, numstat renames, patches round-trip, branch cleanup info, reflog', async () => {
	const dir = mk();
	const other = mk();
	try {
		const g = await init(dir);
		fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n');
		fs.writeFileSync(path.join(dir, 'gone.txt'), 'x\n');
		await g('add', '.');
		await g('commit', '-q', '-m', 'init');
		fs.mkdirSync(path.join(dir, 'lib'));
		await g('mv', 'a.txt', 'lib/a.txt');
		fs.appendFileSync(path.join(dir, 'lib', 'a.txt'), '3\n');
		await g('add', '.');
		await g('commit', '-q', '-m', 'move and grow a');

		const stats = await git.fileStatsLog(dir, path.join(dir, 'lib', 'a.txt'));
		assert.deepStrictEqual(stats.map(s => [s.summary, s.adds, s.dels, s.filename]), [
			['move and grow a', 1, 0, 'lib/a.txt'],
			['init', 2, 0, 'a.txt'],
		]);
		assert.strictEqual(git.numstatPath('src/{old => new}/f.js'), 'src/new/f.js');
		assert.strictEqual(git.numstatPath('{ => sub}/f.js'), 'sub/f.js');
		assert.strictEqual(git.numstatPath('a.txt => b.txt'), 'b.txt');

		fs.appendFileSync(path.join(dir, 'lib', 'a.txt'), '4\n');
		fs.unlinkSync(path.join(dir, 'gone.txt'));
		fs.writeFileSync(path.join(dir, 'new one.txt'), 'brand new\n');
		const st = await git.status(dir);
		assert.deepStrictEqual(st.map(f => [f.path, f.status]).sort(), [['gone.txt', 'D'], ['lib/a.txt', 'M'], ['new one.txt', '?']]);

		// Working patch (incl. untracked + deletion) applies cleanly to a fresh clone.
		const patch = await git.workingPatch(dir);
		await git.run(['clone', '-q', '-c', 'core.autocrlf=false', dir, other]);
		await git.run(['apply', '--whitespace=nowarn', '-'], { cwd: other, input: patch });
		assert.strictEqual(fs.readFileSync(path.join(other, 'new one.txt'), 'utf8'), 'brand new\n');
		assert.ok(!fs.existsSync(path.join(other, 'gone.txt')));
		assert.strictEqual(fs.readFileSync(path.join(other, 'lib', 'a.txt'), 'utf8'), '1\n2\n3\n4\n');
		// Limited to selected paths.
		const partial = await git.workingPatch(dir, ['new one.txt']);
		assert.match(partial, /new one\.txt/);
		assert.doesNotMatch(partial, /gone\.txt|lib\/a\.txt/);

		// Commit patches (format-patch) round-trip through git am, keeping author + message.
		await g('add', '-A');
		await g('commit', '-q', '-m', 'third');
		const shas = (await g('rev-list', '-n2', 'HEAD')).trim().split('\n');
		const mbox = await git.commitsPatch(dir, shas);
		assert.ok(git.isMailboxPatch(mbox));
		assert.ok(mbox.indexOf('move and grow a') < mbox.indexOf('Subject: [PATCH] third'), 'oldest first');
		const g2 = (...a) => git.run(a, { cwd: other });
		await g2('checkout', '-q', '--', '.');
		await g2('clean', '-fdq');
		await g2('reset', '-q', '--hard', 'HEAD~1');
		await g2('config', 'user.name', 'X');
		await g2('config', 'user.email', 'x@x');
		await git.run(['am', '-3'], { cwd: other, input: mbox });
		assert.deepStrictEqual((await g2('log', '--format=%s|%an', '-n2')).trim().split('\n'), ['third|Alice', 'move and grow a|Alice']);
		assert.ok(!git.isMailboxPatch(patch));

		// Branch cleanup facts.
		await g('branch', 'merged-one');
		await g('switch', '-q', '-c', 'unmerged');
		fs.writeFileSync(path.join(dir, 'u.txt'), 'u\n');
		await g('add', '.');
		await g('commit', '-q', '-m', 'unmerged work');
		await g('switch', '-q', 'main');
		const info = Object.fromEntries((await git.branchCleanupInfo(dir)).map(b => [b.name, b]));
		assert.ok(info['merged-one'].merged && !info['merged-one'].current);
		assert.ok(!info.unmerged.merged);
		assert.ok(info.main.current && info.main.worktree);

		const rl = await git.reflog(dir, 5);
		assert.match(rl[0].action, /checkout: moving from unmerged to main/);
		assert.strictEqual(rl[0].selector, 'HEAD@{0}');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(other, { recursive: true, force: true });
	}
});
