import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { type Mode, type SiteRow, chooseSites, renderSites } from "../src/prompt.ts";

process.env.NO_COLOR = "1";

const ROWS: SiteRow[] = [
  {
    id: "x",
    name: "X / Twitter",
    modes: [
      { mode: "off", label: "off", detail: "Not blocked." },
      { mode: "whole", label: "whole site", detail: "Blocked everywhere." },
      { mode: "partial", label: "feed only", detail: "In Chrome only." },
    ],
    hosts: "x.com · twitter.com",
  },
  {
    id: "facebook",
    name: "Facebook",
    modes: [
      { mode: "off", label: "off", detail: "Not blocked." },
      { mode: "whole", label: "whole site", detail: "Blocked everywhere." },
    ],
    hosts: "facebook.com",
  },
];
const INITIAL: Record<string, Mode> = { x: "whole", facebook: "off" };

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

/** Runs the real prompt on in-memory streams, typing `keys` one at a time. */
async function drive(keys: string[], initial = INITIAL) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: () => void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  let frames = "";
  output.on("data", (chunk) => (frames += chunk.toString()));
  const result = chooseSites(ROWS, initial, { message: "What should focus block?", input, output });
  for (const key of keys) {
    await Bun.sleep(5);
    input.write(key);
  }
  return { result: await result, frames };
}

test("←/→ change the focused site's mode, clamped at the ends", async () => {
  const { result } = await drive([RIGHT, RIGHT, RIGHT, "\r"]);
  expect(result).toEqual({ values: { x: "partial", facebook: "off" }, add: false });
  const back = await drive([LEFT, LEFT, LEFT, "\r"]);
  expect(back.result!.values.x).toBe("off");
});

test("↑/↓ move between sites, and digits pick a mode directly", async () => {
  const { result } = await drive([DOWN, "2", UP, "3", "\r"]);
  expect(result!.values).toEqual({ x: "partial", facebook: "whole" });
});

test("Space cycles through a site's modes", async () => {
  const { result } = await drive([" ", " ", "\r"]);
  expect(result!.values.x).toBe("off"); // whole → feed only → off
});

test("Enter on the last row asks to add a site, keeping the choices so far", async () => {
  const { result } = await drive([DOWN, "2", DOWN, "\r"]);
  expect(result).toEqual({ values: { x: "whole", facebook: "whole" }, add: true });
});

test("Esc cancels", async () => {
  const { result } = await drive([RIGHT, "\x1b"]);
  expect(result).toBeNull();
});

test("rows look the same with or without the cursor; the focused one is explained below the list", () => {
  const frame = renderSites(ROWS, INITIAL, "x", "active", { message: "What should focus block?", header: "focus is on" }, 100);
  expect(frame).toBe(
    [
      "◆  What should focus block?",
      "│  focus is on",
      "│",
      "│ › X / Twitter  ○ off  ● whole site  ○ feed only",
      "│   Facebook     ● off  ○ whole site",
      "│   + Add a site…",
      "│",
      "│  Blocked everywhere.",
      "│  x.com · twitter.com",
      "│",
      "└  ↑/↓ site · ←/→ or 1-3 mode · Enter: done · Esc: cancel",
    ].join("\n"),
  );
});

test("moving the cursor changes only the cursor and the area below the list", () => {
  const options = { message: "m" };
  const lines = (cursor: string) => renderSites(ROWS, INITIAL, cursor, "active", options, 100).split("\n");
  const [onX, onFacebook, onAdd] = [lines("x"), lines("facebook"), lines("\0add")];
  expect(onFacebook.length).toBe(onX.length);
  expect(onAdd.length).toBe(onX.length);
  const strip = (line: string) => line.replace("›", " ");
  expect(onFacebook.slice(0, 5).map(strip)).toEqual(onX.slice(0, 5).map(strip));
  expect(onFacebook[6]).toBe("│  Not blocked.");
  expect(onAdd[6]).toContain("example.com");
});

test("a row with a note takes no more lines than one without", () => {
  const rows = [ROWS[0]!, { ...ROWS[1]!, note: "Its Chrome option is set too; the whole site wins." }];
  const height = (cursor: string) => renderSites(rows, INITIAL, cursor, "active", { message: "m" }, 100).split("\n").length;
  expect(height("facebook")).toBe(height("x"));
});

test("long lines below the list are cut rather than wrapped", () => {
  const long = [{ ...ROWS[0]!, hosts: "a.com · ".repeat(30) }];
  const frame = renderSites(long, INITIAL, "x", "active", { message: "m" }, 80);
  for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
});

test("narrow terminals show only the current mode on each row, and the focused row's choices below", () => {
  const frame = renderSites(ROWS, INITIAL, "x", "active", { message: "m" }, 60);
  expect(frame).toContain("│ › X / Twitter  whole site\n");
  expect(frame).toContain("│   Facebook     off\n");
  expect(frame).toContain("│  ○ off  ● whole site  ○ feed only\n");
});
