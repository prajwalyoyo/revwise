'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/git');
const { formatTemplate, shortAgo } = require('../src/format');

async function makeRepo() {
	const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'revwise-')));
	const g = (...a) => git.run(a, { cwd: dir });
	await g('init', '-q');
	await g('config', 'user.name', 'Alice');
	await g('config', 'user.email', 'alice@example.com');
	await g('config', 'commit.gpgsign', 'false');
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
	await g('add', '.');
	await g('commit', '-q', '-m', 'first commit');
	await g('config', 'user.name', 'Bob');
	await g('config', 'user.email', 'bob@example.com');
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
	await g('commit', '-q', '-am', 'second: change line 2');
	await g('mv', 'a.txt', 'b.txt');
	await g('commit', '-q', '-m', 'rename a to b');
	return dir;
}

test('blame, dirty blame and file history against a real repo', async () => {
	const dir = await makeRepo();
	try {
		const file = path.join(dir, 'b.txt');
		const root = await git.getRepoRoot(dir);
		assert.strictEqual(root.toLowerCase(), dir.toLowerCase());

		const { commits, lines } = await git.blame(root, file);
		assert.strictEqual(lines.length, 3);
		const c1 = commits.get(lines[0].sha);
		const c2 = commits.get(lines[1].sha);
		assert.strictEqual(c1.author, 'Alice');
		assert.strictEqual(c1.email, 'alice@example.com');
		assert.strictEqual(c1.summary, 'first commit');
		assert.strictEqual(lines[0].filename, 'a.txt', 'tracks original filename across rename');
		assert.strictEqual(c2.author, 'Bob');
		assert.strictEqual(c2.summary, 'second: change line 2');
		assert.ok(c2.previousSha && c2.previousFilename === 'a.txt');
		assert.strictEqual(lines[2].sha, lines[0].sha);

		const dirty = await git.blame(root, file, { contents: 'zero\none\nTWO\nthree\n' });
		assert.strictEqual(dirty.lines.length, 4);
		assert.ok(dirty.commits.get(dirty.lines[0].sha).uncommitted);
		assert.strictEqual(dirty.commits.get(dirty.lines[2].sha).author, 'Bob');

		const log = await git.fileLog(root, file);
		assert.deepStrictEqual(log.map(e => e.summary), ['rename a to b', 'second: change line 2', 'first commit']);
		assert.deepStrictEqual(log.map(e => e.filename), ['b.txt', 'a.txt', 'a.txt']);
		assert.strictEqual(log[2].parent, undefined);

		const old = await git.show(root, log[2].sha, 'a.txt');
		assert.strictEqual(old.replace(/\r/g, ''), 'one\ntwo\nthree\n');

		assert.strictEqual(await git.getRepoRoot(os.tmpdir()), null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('formatTemplate', () => {
	const commit = { sha: 'abcdef1234567890', author: 'Bob', email: 'bob@x', summary: 'x'.repeat(80), date: new Date(Date.now() - 3 * 86400e3) };
	assert.strictEqual(formatTemplate('${sha} ${author}', commit), 'abcdef1 Bob');
	assert.strictEqual(formatTemplate('${author}', commit, { you: 'bob@x' }), 'You');
	assert.strictEqual(formatTemplate('${summary}', commit).length, 50);
	assert.match(formatTemplate('${ago}', commit), /3 days ago/);
	assert.strictEqual(formatTemplate('${ago}', { ...commit, sha: git.UNCOMMITTED, uncommitted: true }), 'You, Uncommitted changes');
	assert.strictEqual(formatTemplate('${agoShort|4}|${author|5}|', commit), '3d  |Bob  |');
	assert.strictEqual(formatTemplate('${author|3}', { ...commit, author: 'Prajwal' }), 'Pr…');
});

test('shortAgo', () => {
	const now = Date.UTC(2026, 0, 1);
	const ago = s => shortAgo(new Date(now - s * 1000), now);
	assert.strictEqual(ago(10), 'now');
	assert.strictEqual(ago(5 * 60), '5m');
	assert.strictEqual(ago(3 * 3600), '3h');
	assert.strictEqual(ago(2 * 86400), '2d');
	assert.strictEqual(ago(60 * 86400), '2mo');
	assert.strictEqual(ago(400 * 86400), '1y');
});

test('parseIncrementalBlame handles CRLF and empty input', () => {
	assert.strictEqual(git.parseIncrementalBlame('').lines.length, 0);
	const sha = 'a'.repeat(40);
	const out = `${sha} 1 1 2\r\nauthor Z\r\nauthor-time 0\r\nsummary s\r\nfilename f.txt\r\n`;
	const r = git.parseIncrementalBlame(out);
	assert.strictEqual(r.lines.length, 2);
	assert.strictEqual(r.commits.get(sha).author, 'Z');
	assert.strictEqual(r.lines[1].filename, 'f.txt');
});
