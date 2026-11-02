// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const COLORS = ['#15a0bf', '#f25d2e', '#7bd938', '#c517b6', '#f2ca33', '#0669f7', '#2ece9d', '#d90171', '#8e00c2', '#cd0101'];
	const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
	const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const DAY = 86400000;

	let all = [];
	let rangeDays = 0;
	let hiddenAuthors = new Set();
	let file = '';

	function fmtDate(ms) {
		return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	function visible() {
		const cutoff = rangeDays ? Date.now() - rangeDays * DAY : 0;
		return all.filter(c => c.date >= cutoff);
	}

	function authorsOf(list) {
		const map = new Map();
		for (const c of all) if (!map.has(c.author)) map.set(c.author, { name: c.author, color: COLORS[map.size % COLORS.length], commits: 0, adds: 0, dels: 0 });
		for (const c of list) {
			const a = map.get(c.author);
			a.commits++;
			a.adds += c.adds;
			a.dels += c.dels;
		}
		return [...map.values()].filter(a => a.commits).sort((a, b) => b.commits - a.commits);
	}

	function render() {
		const list = visible();
		const authors = authorsOf(list);
		const shown = list.filter(c => !hiddenAuthors.has(c.author));
		const chart = $('chart');
		$('file').textContent = file;
		$('file').title = file;
		if (!list.length) {
			chart.innerHTML = `<div class="message">${all.length ? 'No commits in this time range.' : 'No history for this file.'}</div>`;
			$('legend').innerHTML = '';
			$('summary').textContent = '';
			return;
		}
		const totalAdds = list.reduce((n, c) => n + c.adds, 0);
		const totalDels = list.reduce((n, c) => n + c.dels, 0);
		$('summary').innerHTML =
			`${list.length} commit${list.length === 1 ? '' : 's'} by ${authors.length} author${authors.length === 1 ? '' : 's'} • ` +
			`<span class="add">+${totalAdds}</span> <span class="del">−${totalDels}</span> • ${fmtDate(list[list.length - 1].date)} – ${fmtDate(list[0].date)}`;

		const W = Math.max(280, chart.clientWidth);
		const laneH = 26;
		const labelW = Math.min(140, Math.max(70, W * 0.22));
		const padR = 14;
		const lanesH = authors.length * laneH;
		const barsH = 70;
		const axisH = 22;
		const H = lanesH + barsH + axisH + 12;
		const minT = Math.min(...list.map(c => c.date));
		const maxT = Math.max(...list.map(c => c.date));
		const span = Math.max(DAY, maxT - minT);
		const x = t => labelW + ((t - minT) / span) * (W - labelW - padR - 8) + 4;
		const maxLines = Math.max(1, ...list.map(c => c.adds + c.dels));
		const maxBar = Math.max(1, ...list.map(c => Math.max(c.adds, c.dels)));
		const r = c => 3 + Math.sqrt((c.adds + c.dels) / maxLines) * 9;
		const laneOf = new Map(authors.map((a, i) => [a.name, i]));
		const colorOf = new Map(authors.map(a => [a.name, a.color]));

		let svg = `<svg width="${W}" height="${H}" role="img" aria-label="Commit timeline">`;
		authors.forEach((a, i) => {
			const y = i * laneH + laneH / 2;
			svg += `<line class="lane" x1="${labelW}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
			svg += `<text class="lane-label${hiddenAuthors.has(a.name) ? ' off' : ''}" x="${labelW - 8}" y="${y + 4}" text-anchor="end">${esc(a.name.length > 18 ? a.name.slice(0, 17) + '…' : a.name)}</text>`;
		});
		// Additions above / deletions below a baseline.
		const base = lanesH + barsH / 2 + 6;
		svg += `<line class="baseline" x1="${labelW}" x2="${W - padR}" y1="${base}" y2="${base}"/>`;
		svg += `<text class="axis" x="${labelW - 8}" y="${base - barsH / 2 + 10}" text-anchor="end">+${maxBar}</text>`;
		svg += `<text class="axis" x="${labelW - 8}" y="${base + barsH / 2 - 2}" text-anchor="end">−${maxBar}</text>`;
		const bw = Math.max(2, Math.min(8, (W - labelW) / Math.max(1, list.length) - 1));
		for (const c of shown) {
			const cx = x(c.date);
			const ha = (c.adds / maxBar) * (barsH / 2 - 4);
			const hd = (c.dels / maxBar) * (barsH / 2 - 4);
			if (ha) svg += `<rect class="bar-add" x="${cx - bw / 2}" y="${base - ha}" width="${bw}" height="${ha}"/>`;
			if (hd) svg += `<rect class="bar-del" x="${cx - bw / 2}" y="${base}" width="${bw}" height="${hd}"/>`;
		}
		for (const c of shown) {
			const cy = laneOf.get(c.author) * laneH + laneH / 2;
			svg += `<circle class="dot" data-sha="${c.sha}" cx="${x(c.date)}" cy="${cy}" r="${r(c).toFixed(1)}" fill="${colorOf.get(c.author)}"/>`;
		}
		// Time axis ticks.
		const ticks = Math.max(2, Math.min(6, Math.floor((W - labelW) / 110)));
		for (let i = 0; i <= ticks; i++) {
			const t = minT + (span * i) / ticks;
			svg += `<text class="axis" x="${x(t)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${esc(fmtDate(t))}</text>`;
		}
		svg += '</svg>';
		chart.innerHTML = svg;

		$('legend').innerHTML = authors
			.map(a => {
				const pct = Math.round((a.commits / list.length) * 100);
				return `<div class="author${hiddenAuthors.has(a.name) ? ' off' : ''}" data-author="${esc(a.name)}" title="Click to show/hide">` +
					`<span class="swatch" style="background:${a.color}"></span><span class="name">${esc(a.name)}</span>` +
					`<span class="stats">${a.commits} commit${a.commits === 1 ? '' : 's'} (${pct}%) <span class="add">+${a.adds}</span> <span class="del">−${a.dels}</span></span></div>`;
			})
			.join('');
	}

	const tip = $('tip');
	$('chart').addEventListener('mousemove', ev => {
		const t = /** @type {Element} */ (ev.target);
		if (!t.classList.contains('dot')) {
			tip.classList.add('hidden');
			return;
		}
		const c = all.find(x => x.sha === t.getAttribute('data-sha'));
		if (!c) return;
		tip.innerHTML =
			`<div class="t-sum">${esc(c.summary)}</div>` +
			`<div class="muted">${esc(c.author)} • ${esc(new Date(c.date).toLocaleString())}</div>` +
			`<div><span class="add">+${c.adds}</span> <span class="del">−${c.dels}</span>${c.binary ? ' (binary)' : ''} • <code>${c.sha.slice(0, 7)}</code></div>` +
			`<div class="muted hint">Click: open changes • Alt+click: show commit</div>`;
		tip.classList.remove('hidden');
		const w = tip.offsetWidth;
		const h = tip.offsetHeight;
		tip.style.left = Math.min(ev.clientX + 12, window.innerWidth - w - 6) + 'px';
		tip.style.top = (ev.clientY + 14 + h > window.innerHeight ? ev.clientY - h - 10 : ev.clientY + 14) + 'px';
	});
	$('chart').addEventListener('mouseleave', () => tip.classList.add('hidden'));
	$('chart').addEventListener('click', ev => {
		const t = /** @type {Element} */ (ev.target);
		const sha = t.getAttribute && t.getAttribute('data-sha');
		if (sha) vscode.postMessage({ type: ev.altKey ? 'showCommit' : 'open', sha });
	});
	$('legend').addEventListener('click', ev => {
		const el = /** @type {HTMLElement} */ (ev.target).closest('.author');
		if (!el) return;
		const name = el.getAttribute('data-author');
		if (hiddenAuthors.has(name)) hiddenAuthors.delete(name);
		else hiddenAuthors.add(name);
		render();
	});
	$('ranges').addEventListener('click', ev => {
		const b = /** @type {HTMLElement} */ (ev.target).closest('button');
		if (!b) return;
		rangeDays = +(b.getAttribute('data-range') || 0);
		for (const x of $('ranges').querySelectorAll('button')) x.classList.toggle('on', x === b);
		render();
	});
	let resizeTimer;
	window.addEventListener('resize', () => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(render, 60);
	});

	window.addEventListener('message', ev => {
		const m = ev.data;
		if (m.type === 'data') {
			all = m.commits;
			file = m.file;
			hiddenAuthors = new Set();
			render();
		} else if (m.type === 'loading') {
			$('file').textContent = m.file;
			$('summary').textContent = 'Loading…';
		} else if (m.type === 'empty') {
			all = [];
			file = '';
			$('file').textContent = '';
			$('summary').textContent = '';
			$('legend').innerHTML = '';
			$('chart').innerHTML = `<div class="message">${esc(m.message)}</div>`;
		}
	});
	vscode.postMessage({ type: 'ready' });
})();
