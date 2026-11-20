// Line-based LCS diff and three-way merge (diff3 style), used to reconcile user edits with
// regenerated content without silently dropping either side.

const MAX_CELLS = 6_000_000;

/** For every line of `a`, the index of the matched line in `b` (LCS), or -1. Undefined when too large. */
export function lcsMatch(a: string[], b: string[]): Int32Array | undefined {
  // trim common prefix/suffix first: cheap and keeps the DP small for typical edits
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  const match = new Int32Array(a.length).fill(-1);
  for (let i = 0; i < pre; i++) match[i] = i;
  for (let k = 0; k < suf; k++) match[a.length - 1 - k] = b.length - 1 - k;
  if (n === 0 || m === 0) return match;
  if ((n + 1) * (m + 1) > MAX_CELLS) return undefined;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[pre + i] === b[pre + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[pre + i] === b[pre + j]) {
      match[pre + i] = pre + j;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return match;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

export interface MergeResult {
  clean: boolean;
  conflicts: number;
  /** merged lines; when not clean, conflicting hunks are wrapped in git-style markers */
  lines: string[];
}

export function merge3(base: string[], ours: string[], theirs: string[], labels = { ours: 'yours (vault)', theirs: 'regenerated (source)' }): MergeResult | undefined {
  const mo = lcsMatch(base, ours);
  const mt = lcsMatch(base, theirs);
  if (!mo || !mt) return undefined;
  const out: string[] = [];
  let conflicts = 0;
  let bi = 0;
  let oi = 0;
  let ti = 0;
  const resolve = (b: string[], o: string[], t: string[]) => {
    if (same(o, b)) out.push(...t);
    else if (same(t, b)) out.push(...o);
    else if (same(o, t)) out.push(...o);
    else {
      conflicts++;
      out.push(`<<<<<<< ${labels.ours}`, ...o, '=======', ...t, `>>>>>>> ${labels.theirs}`);
    }
  };
  for (let i = 0; i < base.length; i++) {
    const o = mo[i];
    const t = mt[i];
    if (o < 0 || t < 0 || o < oi || t < ti) continue;
    resolve(base.slice(bi, i), ours.slice(oi, o), theirs.slice(ti, t));
    out.push(base[i]);
    bi = i + 1;
    oi = o + 1;
    ti = t + 1;
  }
  resolve(base.slice(bi), ours.slice(oi), theirs.slice(ti));
  return { clean: conflicts === 0, conflicts, lines: out };
}

export function mergeText(base: string, ours: string, theirs: string): MergeResult | undefined {
  return merge3(base.split('\n'), ours.split('\n'), theirs.split('\n'));
}

/** Compact unified-style diff for reports (no context folding beyond `ctx` lines). */
export function unifiedDiff(a: string, b: string, ctx = 2, maxLines = 80): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  const m = lcsMatch(al, bl);
  if (!m) return `(diff too large: ${al.length} → ${bl.length} lines)`;
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let j = 0;
  for (let i = 0; i < al.length; i++) {
    if (m[i] < 0) {
      ops.push({ t: '-', s: al[i] });
      continue;
    }
    while (j < m[i]) ops.push({ t: '+', s: bl[j++] });
    ops.push({ t: ' ', s: al[i] });
    j = m[i] + 1;
  }
  while (j < bl.length) ops.push({ t: '+', s: bl[j++] });
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t !== ' ') for (let x = Math.max(0, k - ctx); x <= Math.min(ops.length - 1, k + ctx); x++) keep[x] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (keep[k]) {
      out.push(`${o.t} ${o.s}`);
      skipped = false;
    } else if (!skipped) {
      out.push('  …');
      skipped = true;
    }
  });
  return out.slice(0, maxLines).join('\n') + (out.length > maxLines ? `\n  … (${out.length - maxLines} more lines)` : '');
}
