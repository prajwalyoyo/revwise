#!/usr/bin/env node
'use strict';
// Git sequence editor / editor used by Revwise's commit rewriting.
//   seq-editor.js <git-rebase-todo>   rewrites the todo according to $REVWISE_PLAN (JSON)
//   seq-editor.js --noop <file>       accepts the file as-is (used as GIT_EDITOR for squash/continue)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
if (args[0] === '--noop' || !process.env.REVWISE_PLAN) process.exit(0);
const todoFile = args[0];
if (!todoFile || path.basename(todoFile) !== 'git-rebase-todo') process.exit(0);

const plan = JSON.parse(fs.readFileSync(process.env.REVWISE_PLAN, 'utf8'));
const PICK_LIKE = /^(pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)\s+([0-9a-f]{4,40})(?:\s+(.*))?$/;
const q = p => `"${p.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
const amend = file => `exec git commit --amend --only --allow-empty -F ${q(file)}`;

function parse(text) {
	return text.split(/\r?\n/).map(raw => {
		const m = PICK_LIKE.exec(raw.trim());
		return m ? { raw, verb: m[1], abbr: m[2], rest: m[3] || '' } : { raw };
	});
}

const full = (abbr, shas) => shas.find(s => s.startsWith(abbr));
let msgCounter = 0;
function writeMessage(text) {
	const file = path.join(plan.dir, `msg-${++msgCounter}.txt`);
	fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n');
	return file;
}

let out;
if (plan.mode === 'replace') {
	// User-edited plan. `reword <sha> <text>` changes the subject line to <text>, keeping the body.
	out = [];
	for (const line of parse(plan.todo)) {
		if (line.verb === 'reword' || line.verb === 'r') {
			const original = execFileSync('git', ['log', '-1', '--format=%B', line.abbr], { encoding: 'utf8' }).replace(/\s+$/, '');
			const [subject, ...body] = original.split('\n');
			out.push(`pick ${line.abbr} ${line.rest}`);
			if (line.rest.trim() && line.rest.trim() !== subject.trim()) {
				out.push(amend(writeMessage([line.rest.trim(), ...body].join('\n'))));
			}
		} else {
			out.push(line.raw);
		}
	}
} else {
	const shas = plan.shas;
	let lines = parse(fs.readFileSync(todoFile, 'utf8'));
	// Group: move members right after the target so fixup/squash apply to it.
	if (plan.group) {
		const isMember = l => l.abbr && plan.group.members.includes(full(l.abbr, shas));
		const members = lines.filter(isMember);
		lines = lines.filter(l => !isMember(l));
		const t = lines.findIndex(l => l.abbr && full(l.abbr, shas) === plan.group.target);
		if (t === -1) throw new Error('Revwise: squash target not found in rebase todo');
		lines.splice(t + 1, 0, ...members);
	}
	const final = lines.map(l => {
		if (!l.abbr) return l;
		const sha = full(l.abbr, shas);
		const verb = (sha && plan.actions[sha]) || l.verb;
		return { ...l, sha, verb, raw: `${verb} ${l.abbr} ${l.rest}` };
	});
	out = [];
	for (let i = 0; i < final.length; i++) {
		out.push(final[i].raw);
		const msg = final[i].sha && plan.rewords[final[i].sha];
		if (!msg) continue;
		// Amend after the target and any fixups folded into it.
		while (i + 1 < final.length && /^(fixup|f|squash|s)$/.test(final[i + 1].verb || '')) out.push(final[++i].raw);
		out.push(amend(msg));
	}
}

fs.writeFileSync(todoFile, out.join('\n') + '\n');
