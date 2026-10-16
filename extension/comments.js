// @ts-check
// Runs on bare /comments/<id> pages, which is where redd.it shortlinks land. The URL doesn't
// say which subreddit the post is in, so report the one its canonical link names.
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
