// @ts-check
// Explains a blocked Reddit page, and returns to it once it's allowed or focus is off.
import { subredditOf } from "./rules.js";

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

element("url").textContent = url;
setWithCode(
  element("howto"),
  subreddit
    ? `To allow it, run \`focus reddit allow ${subreddit}\`. To take a break, run \`focus off\`.`
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
  if (reply?.hostError) setWithCode(error, `${reply.hostError}. If this persists, run \`focus reddit install\`.`);
}

void recheck();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void recheck();
});
