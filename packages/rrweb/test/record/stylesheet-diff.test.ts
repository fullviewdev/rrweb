import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  diffRules,
  StyleSheetDiffTracker,
} from '../../src/record/stylesheet-diff';
import type { styleSheetRuleParam } from '@rrweb/types';

/** What the player does with the hunks, in the order the tracker emits them. */
function applyHunks(
  before: string[],
  hunks: ReturnType<typeof diffRules>,
): string[] {
  const sheet = before.slice();
  for (let h = hunks.length - 1; h >= 0; h--) {
    const hunk = hunks[h];
    for (let i = 0; i < hunk.removes; i++) sheet.splice(hunk.at, 1);
    hunk.adds.forEach((rule, k) => sheet.splice(hunk.at + k, 0, rule));
  }
  return sheet;
}

describe('diffRules', () => {
  it('reports no edit for identical sheets', () => {
    expect(diffRules(['a{}', 'b{}'], ['a{}', 'b{}'])).toEqual([]);
    expect(diffRules([], [])).toEqual([]);
  });

  it('turns a cleared and rewritten block into nothing', () => {
    // The Cherry cycle: delete the first 106 rules one by one, insert the same 106 back.
    const reset = Array.from({ length: 106 }, (_, i) => `.r${i}{}`);
    expect(diffRules([...reset, 'x{}'], [...reset, 'x{}'])).toEqual([]);
  });

  it('isolates the 7 rules a cycle leaves behind', () => {
    const reset = Array.from({ length: 106 }, (_, i) => `.r${i}{}`);
    const extra = Array.from({ length: 7 }, (_, i) => `.dup${i}{}`);
    expect(diffRules([...reset, 'x{}'], [...reset, ...extra, 'x{}'])).toEqual([
      { at: 106, removes: 0, adds: extra },
    ]);
  });

  it('describes an append, a prepend, a delete and a replacement', () => {
    expect(diffRules(['a{}'], ['a{}', 'b{}'])).toEqual([
      { at: 1, removes: 0, adds: ['b{}'] },
    ]);
    expect(diffRules(['a{}'], ['z{}', 'a{}'])).toEqual([
      { at: 0, removes: 0, adds: ['z{}'] },
    ]);
    expect(diffRules(['a{}', 'b{}', 'c{}'], ['a{}', 'c{}'])).toEqual([
      { at: 1, removes: 1, adds: [] },
    ]);
    expect(diffRules(['a{}', 'b{}', 'c{}'], ['a{}', 'B{}', 'c{}'])).toEqual([
      { at: 1, removes: 1, adds: ['B{}'] },
    ]);
  });

  it('keeps two unrelated changes in one frame as two small hunks', () => {
    // An edit near the top and an append at the end, the shape that made one contiguous hunk
    // rewrite a hundred rules in between.
    const reset = Array.from({ length: 100 }, (_, i) => `.r${i}{}`);
    const edited = reset.slice();
    edited[10] = '.r10{padding:1px}';
    const hunks = diffRules(reset, [...edited, '.new{}']);
    expect(hunks).toEqual([
      { at: 10, removes: 1, adds: ['.r10{padding:1px}'] },
      { at: 100, removes: 0, adds: ['.new{}'] },
    ]);
  });

  it('does not let the suffix overlap the prefix on repeated rules', () => {
    expect(diffRules(['a{}'], ['a{}', 'a{}'])).toEqual([
      { at: 1, removes: 0, adds: ['a{}'] },
    ]);
    expect(diffRules(['a{}', 'a{}'], ['a{}'])).toEqual([
      { at: 1, removes: 1, adds: [] },
    ]);
  });

  it('applies back to the new sheet for random edits', () => {
    // A seeded generator: random sheets of repeated rule texts, random deletes, inserts and moves.
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const before = Array.from({ length: rand(60) }, () => `.r${rand(12)}{}`);
      const now = before.slice();
      const edits = 1 + rand(6);
      for (let e = 0; e < edits; e++) {
        const kind = rand(3);
        if (kind === 0 && now.length) now.splice(rand(now.length), 1);
        else if (kind === 1)
          now.splice(rand(now.length + 1), 0, `.r${rand(12)}{}`);
        else if (now.length) {
          const [rule] = now.splice(rand(now.length), 1);
          now.splice(rand(now.length + 1), 0, rule);
        }
      }
      expect(applyHunks(before, diffRules(before, now))).toEqual(now);
    }
  });
});

/** What the replayer does with an event: every add in order, then every remove in order. */
function applyEvents(
  before: string[],
  events: styleSheetRuleParam[],
): string[] {
  const sheet = before.slice();
  for (const event of events) {
    (event.adds || []).forEach((add) =>
      sheet.splice(add.index as number, 0, add.rule),
    );
    (event.removes || []).forEach((remove) =>
      sheet.splice(remove.index as number, 1),
    );
  }
  return sheet;
}

/** A stand-in CSSStyleSheet: a mutable rule list the tracker reads through `cssRules`. */
function fakeSheet(rules: string[]) {
  const list = rules.map((cssText) => ({ cssText }));
  return {
    list,
    get cssRules() {
      return Object.assign(list.slice(), { length: list.length });
    },
  } as unknown as CSSStyleSheet & { list: { cssText: string }[] };
}

describe('StyleSheetDiffTracker', () => {
  let doc: Document;
  let raf: (() => void) | undefined;
  let emitted: styleSheetRuleParam[];
  let tracker: StyleSheetDiffTracker;

  beforeEach(() => {
    emitted = [];
    raf = undefined;
    doc = {
      visibilityState: 'visible',
      defaultView: { requestAnimationFrame: (cb: () => void) => (raf = cb) },
    } as unknown as Document;
    tracker = new StyleSheetDiffTracker((p) => emitted.push(p), doc, {
      mode: 'frame',
    });
  });

  afterEach(() => tracker.dispose());

  const frame = () => {
    const cb = raf;
    raf = undefined;
    cb?.();
  };

  it('emits the net change of a frame, removes first, then adds', () => {
    const sheet = fakeSheet(['a{}', 'b{}', 'c{}']);
    expect(tracker.touch(sheet, { id: 7 })).toBe(true);
    // The page: delete b, insert B and B2 in its place, all inside one frame.
    sheet.list.splice(1, 1, { cssText: 'B{}' }, { cssText: 'B2{}' });
    tracker.touch(sheet, { id: 7 });
    expect(emitted).toEqual([]);

    frame();
    // Adds land right after the block they replace, and the block is deleted after them, because
    // the replayer applies an event's adds before its removes.
    expect(emitted).toEqual([
      {
        id: 7,
        adds: [
          { rule: 'B{}', index: 2 },
          { rule: 'B2{}', index: 3 },
        ],
        removes: [{ index: 1 }],
      },
    ]);
    expect(applyEvents(['a{}', 'b{}', 'c{}'], emitted)).toEqual([
      'a{}',
      'B{}',
      'B2{}',
      'c{}',
    ]);
  });

  it('emits nothing for a cycle that leaves the sheet as it was', () => {
    const sheet = fakeSheet(['a{}', 'b{}']);
    tracker.touch(sheet, { id: 7 });
    sheet.list.splice(0, 2);
    tracker.touch(sheet, { id: 7 });
    sheet.list.push({ cssText: 'a{}' }, { cssText: 'b{}' });
    tracker.touch(sheet, { id: 7 });
    frame();
    expect(emitted).toEqual([]);
  });

  it('chunks a large insert into several events, removes riding the last one', () => {
    const small = new StyleSheetDiffTracker((p) => emitted.push(p), doc, {
      mode: 'frame',
      maxRulesPerEvent: 2,
    });
    const sheet = fakeSheet(['old{}']);
    small.touch(sheet, { id: 1 });
    sheet.list.splice(
      0,
      1,
      { cssText: 'a{}' },
      { cssText: 'b{}' },
      { cssText: 'c{}' },
    );
    small.touch(sheet, { id: 1 });
    frame();
    expect(emitted).toEqual([
      {
        id: 1,
        adds: [
          { rule: 'a{}', index: 1 },
          { rule: 'b{}', index: 2 },
        ],
      },
      { id: 1, adds: [{ rule: 'c{}', index: 3 }], removes: [{ index: 0 }] },
    ]);
    expect(applyEvents(['old{}'], emitted)).toEqual(['a{}', 'b{}', 'c{}']);
    small.dispose();
  });

  it('leaves a sheet above maxRules on the per-call path', () => {
    const capped = new StyleSheetDiffTracker((p) => emitted.push(p), doc, {
      mode: 'frame',
      maxRules: 2,
    });
    const big = fakeSheet(['a{}', 'b{}', 'c{}']);
    expect(capped.touch(big, { id: 1 })).toBe(false);
    expect(capped.touch(big, { id: 1 })).toBe(false);
    capped.dispose();
  });

  it('leaves an unreadable sheet on the per-call path', () => {
    const crossOrigin = {
      get cssRules(): CSSRuleList {
        throw new DOMException('blocked', 'SecurityError');
      },
    } as unknown as CSSStyleSheet;
    expect(tracker.touch(crossOrigin, { id: 1 })).toBe(false);
  });

  it('flushes on a microtask in a hidden document, after the call has applied', async () => {
    const hidden = new StyleSheetDiffTracker(
      (p) => emitted.push(p),
      { ...doc, visibilityState: 'hidden' } as unknown as Document,
      { mode: 'frame' },
    );
    const sheet = fakeSheet(['a{}']);
    // As the proxies do: touch first, then the original call applies, twice in one task.
    hidden.touch(sheet, { id: 1 });
    sheet.list.unshift({ cssText: 'h1{}' });
    hidden.touch(sheet, { id: 1 });
    sheet.list.unshift({ cssText: 'h2{}' });
    expect(emitted).toEqual([]);
    expect(raf).toBeUndefined();

    await Promise.resolve();
    expect(emitted).toEqual([
      {
        id: 1,
        adds: [
          { rule: 'h2{}', index: 0 },
          { rule: 'h1{}', index: 1 },
        ],
        removes: [],
      },
    ]);
    hidden.dispose();
  });

  it('flushAll emits what is pending before the frame, and reseed makes the live state the baseline', () => {
    const sheet = fakeSheet(['a{}']);
    tracker.touch(sheet, { id: 1 });
    sheet.list.push({ cssText: 'b{}' });
    tracker.touch(sheet, { id: 1 });
    tracker.flushAll();
    expect(emitted).toEqual([
      { id: 1, adds: [{ rule: 'b{}', index: 1 }], removes: [] },
    ]);

    // A snapshot carried the sheet with a third rule the tracker never saw inserted.
    emitted = [];
    sheet.list.push({ cssText: 'c{}' });
    tracker.reseed([sheet]);
    sheet.list.push({ cssText: 'd{}' });
    tracker.touch(sheet, { id: 1 });
    frame();
    expect(emitted).toEqual([
      { id: 1, adds: [{ rule: 'd{}', index: 3 }], removes: [] },
    ]);
  });

  it('emits one event per sheet per frame that the replayer applies back exactly, for random edits', () => {
    let seed = 777;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const before = Array.from({ length: rand(80) }, () => `.r${rand(10)}{}`);
      const sheet = fakeSheet(before);
      emitted = [];
      tracker.touch(sheet, { id: 5 });
      for (let e = 0; e < 1 + rand(8); e++) {
        const kind = rand(3);
        if (kind === 0 && sheet.list.length)
          sheet.list.splice(rand(sheet.list.length), 1);
        else if (kind === 1)
          sheet.list.splice(rand(sheet.list.length + 1), 0, {
            cssText: `.r${rand(10)}{}`,
          });
        else if (sheet.list.length) {
          const [item] = sheet.list.splice(rand(sheet.list.length), 1);
          sheet.list.splice(rand(sheet.list.length + 1), 0, item);
        }
        tracker.touch(sheet, { id: 5 });
      }
      frame();
      const now = sheet.list.map((r) => r.cssText);
      expect(emitted.length).toBeLessThanOrEqual(1);
      expect(applyEvents(before, emitted)).toEqual(now);
    }
  });
});
