import type { styleSheetRuleCallback } from '@rrweb/types';

export type styleSheetRuleEmitOptions = {
  /**
   * `call` is the historical behaviour: one event per insertRule / deleteRule call, as the page
   * makes them. `frame` records the sheet's state instead of the page's work: a touched sheet is
   * read once per animation frame and only the net change is emitted.
   */
  mode: 'call' | 'frame';
  /**
   * A sheet with more rules than this is left on the `call` path. Reading every rule's text once a
   * frame is what the diff costs, and on a very large sheet that a CSS-in-JS runtime touches every
   * frame it would cost more than the events it saves. Measured in headless Chrome, read plus
   * compare per dirty sheet: 300 rules 0.6 ms (1 ms at 4x CPU throttling), 2,000 rules 2.4 ms
   * (7 ms), 5,000 rules 4.7 ms (17.5 ms, a whole frame), 30,000 rules 29 ms (126 ms). The churn
   * this exists for runs on sheets of a few hundred rules.
   */
  maxRules?: number;
  /** Adds are emitted in events of at most this many rules, so one frame of page load cannot
   * produce a single oversized event. */
  maxRulesPerEvent?: number;
};

export const defaultStyleSheetRuleEmitOptions = {
  maxRules: 2000,
  maxRulesPerEvent: 500,
};

type sheetIds = { id?: number; styleId?: number };

/**
 * Per-frame diff of touched stylesheets, replacing per-call rule events.
 *
 * Why: CSS-in-JS runtimes do far more CSSOM work than the sheet's state ever reflects. One
 * customer's pages delete and re-insert a 106-rule global reset, three times over, on every
 * resize a phone's URL bar causes, which is 657 rule events per scroll stop for a sheet that
 * ends 7 rules longer. The player applies events at frame rate, so anything undone inside a
 * frame was never visible; emitting the net change per frame loses nothing a replay could show
 * and makes the cost proportional to what changed.
 *
 * How: the proxies call {@link touch} before the original method runs. The first touch of a sheet
 * reads its rules as the baseline, so the diff is exact from the first frame without waiting for a
 * snapshot. At the next animation frame every dirty sheet is read again and the common prefix and
 * suffix are stripped; what is left in the middle is emitted as deletes at the prefix index, then
 * inserts, in the two-event order the replayer needs (it applies adds before removes inside one
 * event). The baseline is replaced by what was read, so a sheet is never diffed against a guess.
 *
 * Flushes are forced before anything that must see the sheet as it stands: a full snapshot, any
 * other event source (a style-declaration event addresses a rule by index, a mutation may remove
 * the style element), pagehide, and teardown. Hidden documents flush synchronously, because
 * requestAnimationFrame never fires there and a held frame would surface with a stale timestamp.
 */
export class StyleSheetDiffTracker {
  private lastEmitted = new WeakMap<CSSStyleSheet, string[]>();
  private passthrough = new WeakSet<CSSStyleSheet>();
  private dirty = new Map<CSSStyleSheet, sheetIds>();
  private scheduled = false;
  private disposed = false;
  private readonly maxRules: number;
  private readonly maxRulesPerEvent: number;

  constructor(
    private cb: styleSheetRuleCallback,
    private doc: Document,
    options: styleSheetRuleEmitOptions,
  ) {
    this.maxRules =
      options.maxRules ?? defaultStyleSheetRuleEmitOptions.maxRules;
    this.maxRulesPerEvent =
      options.maxRulesPerEvent ??
      defaultStyleSheetRuleEmitOptions.maxRulesPerEvent;
  }

  /**
   * Called by a proxy before the original call runs. Returns false when the sheet stays on the
   * per-call path (too large, or unreadable), in which case the caller emits as it always has.
   */
  touch(sheet: CSSStyleSheet, ids: sheetIds): boolean {
    if (this.disposed || this.passthrough.has(sheet)) return false;

    if (!this.lastEmitted.has(sheet)) {
      const rules = this.read(sheet);
      if (!rules) return false;
      this.lastEmitted.set(sheet, rules);
    }

    this.dirty.set(sheet, ids);
    this.schedule();
    return true;
  }

  /** Emits the net change of every dirty sheet now. */
  flushAll(): void {
    this.scheduled = false;
    if (this.dirty.size === 0) return;

    const sheets = Array.from(this.dirty.entries());
    this.dirty.clear();
    for (const [sheet, ids] of sheets) this.flushSheet(sheet, ids);
  }

  /**
   * After a full snapshot the player holds every sheet as it is now, so every tracked sheet's
   * baseline becomes its live state. Sheets never touched stay untracked and baseline themselves
   * on their first touch.
   */
  reseed(sheets: Iterable<CSSStyleSheet>): void {
    for (const sheet of sheets) {
      if (!this.lastEmitted.has(sheet)) continue;
      const rules = this.read(sheet);
      if (rules) this.lastEmitted.set(sheet, rules);
    }
  }

  dispose(): void {
    this.flushAll();
    this.disposed = true;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;

    // `touch` runs inside the proxy before the original call has applied, so a flush can never be
    // synchronous: it would read the sheet as it was. In a hidden document requestAnimationFrame
    // never fires and timers are throttled, so the flush rides a microtask instead, which runs
    // once the current task's calls have all applied and is never throttled. That coalesces per
    // task rather than per frame, which is still one diff per churn cycle.
    const win = this.doc.defaultView;
    if (this.doc.visibilityState === 'hidden' || !win) {
      void Promise.resolve().then(() => this.flushAll());
      return;
    }
    win.requestAnimationFrame(() => this.flushAll());
  }

  private flushSheet(sheet: CSSStyleSheet, ids: sheetIds): void {
    const before = this.lastEmitted.get(sheet);
    const now = this.read(sheet);
    if (!before || !now) {
      // Unreadable since the touch: nothing the player can be told, and nothing to diff against
      // next time. The sheet leaves the frame path.
      this.lastEmitted.delete(sheet);
      return;
    }
    this.lastEmitted.set(sheet, now);

    // Hunks are applied from the end of the sheet backwards, so every hunk's index, which is in
    // `before` coordinates, is still right when the player reaches it.
    const hunks = diffRules(before, now);
    for (let h = hunks.length - 1; h >= 0; h--) {
      const hunk = hunks[h];
      if (hunk.removes > 0) {
        this.cb({
          ...ids,
          removes: Array.from({ length: hunk.removes }, () => ({
            index: hunk.at,
          })),
        });
      }
      for (
        let from = 0;
        from < hunk.adds.length;
        from += this.maxRulesPerEvent
      ) {
        const chunk = hunk.adds.slice(from, from + this.maxRulesPerEvent);
        this.cb({
          ...ids,
          adds: chunk.map((rule, k) => ({ rule, index: hunk.at + from + k })),
        });
      }
    }
  }

  /** The sheet's rules as text, or undefined when it cannot or should not be read. */
  private read(sheet: CSSStyleSheet): string[] | undefined {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      this.passthrough.add(sheet);
      return undefined;
    }
    if (rules.length > this.maxRules) {
      this.passthrough.add(sheet);
      return undefined;
    }
    const out = new Array<string>(rules.length);
    for (let i = 0; i < rules.length; i++) out[i] = rules[i].cssText;
    return out;
  }
}

export type ruleHunk = {
  /** Index in the sheet as it was, where the hunk starts. */
  at: number;
  removes: number;
  adds: string[];
};

/** Past this many rules on both sides together, the edit script is not worth computing. */
const maxDiffSize = 4000;
/** An edit script longer than this is a rewrite, and one hunk says that just as well. */
const maxEditDistance = 1000;

/**
 * The edits turning `before` into `now`, as hunks in sheet order. The common prefix and suffix
 * go first because they are the whole story for every churn pattern measured (a block cleared
 * and rewritten, a block appended to). What is left in the middle gets a bounded Myers edit
 * script, so two unrelated changes in one frame, an edit near the top and an append at the end,
 * stay two small hunks instead of one rewrite of everything between them. Past the bounds the
 * middle is one hunk, which is still correct, only less minimal.
 */
export function diffRules(before: string[], now: string[]): ruleHunk[] {
  const max = Math.min(before.length, now.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === now[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === now[now.length - 1 - suffix]
  ) {
    suffix++;
  }

  const a = before.slice(prefix, before.length - suffix);
  const b = now.slice(prefix, now.length - suffix);
  if (a.length === 0 && b.length === 0) return [];

  const script =
    a.length + b.length <= maxDiffSize ? editScript(a, b) : undefined;
  if (!script) return [{ at: prefix, removes: a.length, adds: b }];

  const hunks: ruleHunk[] = [];
  let open: ruleHunk | undefined;
  let ai = 0;
  let bi = 0;
  for (const op of script) {
    if (op === '=') {
      open = undefined;
      ai++;
      bi++;
      continue;
    }
    if (!open) {
      open = { at: prefix + ai, removes: 0, adds: [] };
      hunks.push(open);
    }
    if (op === '-') {
      open.removes++;
      ai++;
    } else {
      open.adds.push(b[bi]);
      bi++;
    }
  }
  return hunks;
}

/**
 * Myers' O(ND) edit script over two rule lists: `=` keep, `-` delete from `a`, `+` insert from
 * `b`, in order. Undefined when the distance exceeds {@link maxEditDistance}.
 */
function editScript(
  a: string[],
  b: string[],
): Array<'=' | '-' | '+'> | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEditDistance);
  const offset = max + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  let found = false;

  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return undefined;

  const reversed: Array<'=' | '-' | '+'> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[k - 1 + offset] < vd[k + 1 + offset])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vd[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push('=');
      x--;
      y--;
    }
    if (d > 0) {
      reversed.push(x === prevX ? '+' : '-');
      x = prevX;
      y = prevY;
    }
  }
  return reversed.reverse();
}
