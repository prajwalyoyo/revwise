'use strict';

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS = [
	['year', 31536000],
	['month', 2592000],
	['week', 604800],
	['day', 86400],
	['hour', 3600],
	['minute', 60],
	['second', 1],
];

function fromNow(date, now = Date.now()) {
	const diff = (date.getTime() - now) / 1000;
	const abs = Math.abs(diff);
	for (const [unit, secs] of UNITS) {
		if (abs >= secs || unit === 'second') return rtf.format(Math.round(diff / secs), unit);
	}
	return '';
}

const SHORT_UNITS = [
	['y', 31536000],
	['mo', 2592000],
	['w', 604800],
	['d', 86400],
	['h', 3600],
	['m', 60],
];

/** Compact age such as "5m", "3d", "2mo", "1y"; "now" under a minute. */
function shortAgo(date, now = Date.now()) {
	const secs = Math.max(0, (now - date.getTime()) / 1000);
	for (const [unit, size] of SHORT_UNITS) if (secs >= size) return `${Math.floor(secs / size)}${unit}`;
	return 'now';
}

/** Pads or truncates (with an ellipsis) to exactly `width` characters. */
function fit(text, width) {
	if (!(width > 0)) return text;
	return text.length > width ? text.slice(0, width - 1) + '…' : text.padEnd(width);
}

function shortSha(sha) {
	return sha.slice(0, 7);
}

/**
 * Replaces ${token} placeholders; unknown tokens render as empty strings.
 * `${token|N}` pads or truncates the value to N characters so columns line up.
 */
function formatTemplate(template, commit, { maxSummary = 50, you } = {}) {
	if (commit.uncommitted) return 'You, Uncommitted changes';
	let summary = commit.summary || '';
	if (maxSummary > 0 && summary.length > maxSummary) summary = summary.slice(0, maxSummary - 1) + '…';
	const author = you && commit.email && commit.email === you ? 'You' : commit.author || '';
	const values = {
		author,
		email: commit.email || '',
		ago: commit.date ? fromNow(commit.date) : '',
		agoShort: commit.date ? shortAgo(commit.date) : '',
		date: commit.date ? commit.date.toLocaleString() : '',
		sha: shortSha(commit.sha),
		summary,
	};
	return template.replace(/\$\{(\w+)(?:\|(\d+))?\}/g, (_, k, w) => fit(values[k] ?? '', Number(w)));
}

module.exports = { fromNow, shortAgo, fit, shortSha, formatTemplate };
