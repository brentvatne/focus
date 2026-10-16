// @ts-check
// Explains a blocked page, and returns to it once it's allowed or focus is off.
import { siteOf, subredditOf } from "./rules.js";

/** Why each site's page is blocked, and what still works. */
const REASONS = {
  reddit: "Only the subreddits you've allowed load while focus is on.",
  youtube: "focus blocks YouTube's home page, Shorts and Explore while it's on. Links to videos, search, channels and your subscriptions still work.",
  x: "focus blocks X's timeline, Explore, search and notifications while it's on. Links to posts and profiles still work.",
};

const url = decodeURIComponent(location.hash.slice(1));
// A bare /comments/<id> URL doesn't name its subreddit; the page reported it instead.
const reported = new URLSearchParams(location.search).get("subreddit");
const subreddit = reported ?? subredditOf(url);

/** @param {string} id */
function element(id) {
  return /** @type {HTMLElement} */ (document.getElementById(id));
}

/** @param {HTMLElement} target @param {string} text */
function setWithCode(target, text) {
  // Text with `code` spans, built without innerHTML.
  target.replaceChildren(
    ...text.split("`").map((part, index) => {
      if (index % 2 === 0) return document.createTextNode(part);
      const code = document.createElement("code");
      code.textContent = part;
      return code;
    }),
  );
}

const site = siteOf(url);
element("url").textContent = url;
if (site) element("reason").textContent = REASONS[site];
setWithCode(
  element("howto"),
  site === "reddit" && subreddit
    ? `To allow it, run \`focus reddit allow ${subreddit}\`. To take a break, run \`focus off\`.`
    : site === "youtube" || site === "x"
      ? `To take a break, run \`focus off\`. To stop blocking the feed, run \`focus feeds remove ${site}\`.`
      : "To take a break, run `focus off`.",
);

async function recheck() {
  if (!url) return;
  const reply = await chrome.runtime.sendMessage({ type: "recheck", url, subreddit: reported });
  if (reply?.allowed) {
    location.replace(url);
    return;
  }
  const error = element("error");
  error.hidden = !reply?.hostError;
  if (reply?.hostError) setWithCode(error, reply.hostError);
}

void recheck();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void recheck();
});
