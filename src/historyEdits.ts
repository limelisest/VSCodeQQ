import type { Rendered } from './transcriptRenderer';

export interface HistoryEdit { start: number; end: number; text: string; }

// Preserve unchanged message blocks even when trimming the head and appending
// the tail in the same update. A single common-prefix/suffix diff replaces all
// the intervening history in that case, invalidating tracked links and tokens.
export function historyEdits(before: string, after: string, previous?: Rendered, next?: Rendered): HistoryEdit[] {
  const edits: HistoryEdit[] = [];
  let oldCursor = 0, newCursor = 0;
  const gap = (oldEnd: number, newEnd: number) => {
    let start = oldCursor, nextStart = newCursor;
    while (start < oldEnd && nextStart < newEnd && before[start] === after[nextStart]) { start++; nextStart++; }
    while (oldEnd > start && newEnd > nextStart && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
    if (start !== oldEnd || nextStart !== newEnd) edits.push({ start, end: oldEnd, text: after.slice(nextStart, newEnd) });
  };
  const blocks = (text: string, rendered: Rendered) => {
    const offsets = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
    const ends = new Map<string, number>();
    for (const [line, id] of rendered.messages) ends.set(id, offsets[line + 1] ?? text.length);
    return new Map([...rendered.starts].flatMap(([id, line]) => {
      const start = offsets[line], end = ends.get(id);
      return start !== undefined && end !== undefined ? [[id, { start, end }] as const] : [];
    }));
  };
  if (previous && next && before.startsWith(previous.text) && after.startsWith(next.text)) {
    const oldBlocks = blocks(before, previous);
    for (const [id, current] of blocks(after, next)) {
      const old = oldBlocks.get(id);
      if (!old || old.start < oldCursor || current.start < newCursor
        || before.slice(old.start, old.end) !== after.slice(current.start, current.end)) continue;
      gap(old.start, current.start);
      oldCursor = old.end; newCursor = current.end;
    }
  }
  gap(before.length, after.length);
  return edits;
}
