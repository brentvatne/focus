type Op = { kind: " " | "-" | "+"; line: string };

const CONTEXT = 3;
// Tags a final line that lacks "\n" so it never compares equal to one that has it.
const NO_EOL = "\u0000";

/** Unified diff of two texts, or "" if they're identical. */
export function unifiedDiff(before: string, after: string, fromLabel: string, toLabel: string): string {
  if (before === after) return "";
  const a = toLines(before);
  const b = toLines(after);

  // focus only rewrites one contiguous region, so trimming the common prefix and
  // suffix keeps the line-by-line LCS below small even for very large hosts files.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: Op[] = [
    ...a.slice(0, prefix).map((line) => ({ kind: " " as const, line })),
    ...diffLines(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)),
    ...a.slice(a.length - suffix).map((line) => ({ kind: " " as const, line })),
  ];

  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const hunk of hunks(ops)) out.push(...hunk);
  return out.join("\n") + "\n";
}

function diffLines(a: string[], b: string[]): Op[] {
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i++]! });
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "-", line: a[i++]! });
    } else {
      ops.push({ kind: "+", line: b[j++]! });
    }
  }
  while (i < a.length) ops.push({ kind: "-", line: a[i++]! });
  while (j < b.length) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

function* hunks(ops: Op[]): Generator<string[]> {
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  let cursor = 0;
  while (cursor < changed.length) {
    const start = Math.max(0, changed[cursor]! - CONTEXT);
    let end = changed[cursor]!;
    while (cursor + 1 < changed.length && changed[cursor + 1]! - end <= CONTEXT * 2) end = changed[++cursor]!;
    end = Math.min(ops.length - 1, end + CONTEXT);
    cursor++;

    let oldStart = 1;
    let newStart = 1;
    for (const op of ops.slice(0, start)) {
      if (op.kind !== "+") oldStart++;
      if (op.kind !== "-") newStart++;
    }
    const body = ops.slice(start, end + 1);
    const oldCount = body.filter((op) => op.kind !== "+").length;
    const newCount = body.filter((op) => op.kind !== "-").length;
    yield [
      `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`,
      ...body.flatMap((op) => {
        const line = op.kind + op.line.replace(NO_EOL, "").replace(/\r$/, "");
        return op.line.endsWith(NO_EOL) ? [line, "\\ No newline at end of file"] : [line];
      }),
    ];
  }
}

function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else lines[lines.length - 1] += NO_EOL;
  return lines;
}

function range(start: number, count: number): string {
  // A zero-length range names the line *before* the change, per the unified diff format.
  if (count === 0) return `${start - 1},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}
