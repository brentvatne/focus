// @ts-check
// Runs on post pages. A bare /comments/<id> or /gallery/<id> URL (where redd.it shortlinks
// land) doesn't say which subreddit the post is in, and /r/<name>/comments/<id> may name the
// wrong one, so report the subreddit the page's canonical link names.
(() => {
  const canonical = document.querySelector('link[rel="canonical"]');
  let subreddit = null;
  if (canonical instanceof HTMLLinkElement) {
    try {
      subreddit = /^\/r\/([^/?#]+)/i.exec(new URL(canonical.href).pathname)?.[1] ?? null;
    } catch {
      // Not a URL; treated like a missing link.
    }
  }
  void chrome.runtime.sendMessage({ type: "comments", url: location.href, subreddit });
})();
