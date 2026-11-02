'use strict';

/**
 * Incremental lane layout for a commit graph.
 * Commits must arrive in an order where children precede parents (git log --date-order/--topo-order).
 * Lanes keep their column for their whole lifetime (no compaction) so pass-through lines are straight;
 * freed columns are reused by new lanes.
 *
 * Each row describes how to draw that commit's slice of the graph:
 *   col      - column of the commit node
 *   color    - color index of the node's lane
 *   pass     - [{ col, color }] lanes passing straight through the row
 *   up       - [{ from, color }] lanes entering from the top that end at the node (the node's own lane plus merges into it)
 *   down     - [{ to, color }] edges leaving the node toward its parents in the next row
 *   width    - number of columns in use for this row
 */
class GraphLayout {
	constructor() {
		this.lanes = []; // column -> { sha, color } | null
		this.nextColor = 0;
		this.maxWidth = 0;
	}

	_alloc(sha, color) {
		let i = this.lanes.indexOf(null);
		if (i === -1) i = this.lanes.length;
		this.lanes[i] = { sha, color: color ?? this.nextColor++ };
		return i;
	}

	add(commit) {
		const lanes = this.lanes;
		const up = [];
		const pass = [];
		let col = -1;
		let color;

		for (let i = 0; i < lanes.length; i++) {
			const l = lanes[i];
			if (!l) continue;
			if (l.sha === commit.sha) {
				up.push({ from: i, color: l.color });
				if (col === -1) {
					col = i;
					color = l.color;
				}
				lanes[i] = null;
			} else {
				pass.push({ col: i, color: l.color });
			}
		}

		if (col === -1) {
			// Branch tip: no child seen yet.
			col = this._alloc(commit.sha);
			color = lanes[col].color;
			lanes[col] = null;
		}

		const down = [];
		const parents = commit.parents || [];
		for (let p = 0; p < parents.length; p++) {
			const parent = parents[p];
			const existing = lanes.findIndex(l => l && l.sha === parent);
			if (existing !== -1) {
				down.push({ to: existing, color: lanes[existing].color });
				continue;
			}
			let target;
			if (p === 0 && lanes[col] == null) {
				lanes[col] = { sha: parent, color };
				target = col;
			} else {
				target = this._alloc(parent);
			}
			down.push({ to: target, color: lanes[target].color });
		}

		while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();

		let width = col + 1;
		for (const x of pass) width = Math.max(width, x.col + 1);
		for (const x of up) width = Math.max(width, x.from + 1);
		for (const x of down) width = Math.max(width, x.to + 1);
		this.maxWidth = Math.max(this.maxWidth, width);

		return { col, color, pass, up, down, width };
	}
}

module.exports = { GraphLayout };
