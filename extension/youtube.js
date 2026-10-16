// @ts-check
// On YouTube, while focus blocks its feed: hides recommendations (youtube.css, switched on by an
// attribute so it follows focus on and off without a reload) and stops autoplay from moving on
// to a recommended video. The policy is the one background.js caches.
(() => {
  const ATTRIBUTE = "data-focus-hide-recommendations";
  const root = document.documentElement;

  /** @param {unknown} policy */
  function apply(policy) {
    const p = /** @type {{ state?: string, feeds?: string[] } | undefined} */ (policy);
    root.toggleAttribute(ATTRIBUTE, p?.state === "on" && (p.feeds ?? []).includes("youtube"));
  }

  void chrome.storage.local.get("policy").then(({ policy }) => apply(policy));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.policy) apply(changes.policy.newValue);
  });

  // When a video ends, YouTube counts down to a recommended one. Cancel that, unless you're
  // working through a playlist, where the next video is one you chose.
  document.addEventListener(
    "ended",
    () => {
      if (!root.hasAttribute(ATTRIBUTE) || new URLSearchParams(location.search).has("list")) return;
      setTimeout(() => {
        const cancel = document.querySelector(".ytp-autonav-endscreen-upnext-cancel-button");
        if (cancel instanceof HTMLElement) cancel.click();
      }, 100);
    },
    true,
  );
})();
