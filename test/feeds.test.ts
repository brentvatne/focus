import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedsError, findFeedSite, readFeeds, writeFeeds } from "../src/feeds.ts";

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "focus-feeds-"));
  path = join(dir, "focus", "feeds.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("no file means no feeds", async () => {
  expect(await readFeeds(path)).toEqual([]);
});

test("writes and reads back in catalog order, readable by everyone", async () => {
  await writeFeeds(path, ["x", "youtube"]);
  expect(await Bun.file(path).text()).toBe('{\n  "version": 1,\n  "feeds": [\n    "youtube",\n    "x"\n  ]\n}\n');
  expect(await readFeeds(path)).toEqual(["youtube", "x"]);
  expect((await stat(path)).mode & 0o777).toBe(0o644);
});

test.each([
  ["{ nope", /invalid JSON/],
  ["[]", /expected a JSON object/],
  ['{"version":2,"feeds":[]}', /unsupported version/],
  ['{"version":1,"feeds":["facebook"]}', /must be a list of youtube, x/],
  ['{"version":1,"feeds":"youtube"}', /must be a list/],
  ['{"version":1,"feeds":[],"extra":true}', /unknown key 'extra'/],
])("refuses %s", async (content, message) => {
  await Bun.write(path, content);
  await expect(readFeeds(path)).rejects.toThrow(FeedsError);
  await expect(readFeeds(path)).rejects.toThrow(message);
});

test("findFeedSite ignores case and knows only feed sites", () => {
  expect(findFeedSite("YouTube")?.preset).toBe("youtube");
  expect(findFeedSite("facebook")).toBeUndefined();
});
