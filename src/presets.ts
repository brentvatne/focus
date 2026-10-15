export interface Preset {
  id: string;
  name: string;
  /** Exact hostnames, www variants included, so presets don't depend on --exact. */
  hosts: string[];
  /** Checked by default in `focus init` and used by `focus init --yes`. */
  recommended: boolean;
  note?: string;
}

// /etc/hosts has no wildcards, so each preset lists the hostnames people actually
// land on. Shared CDNs (fbcdn.net, ytimg.com, googlevideo.com, redditmedia.com)
// are left alone so embeds and other apps that use them keep working.
export const PRESETS: Preset[] = [
  {
    id: "x",
    name: "X / Twitter",
    hosts: ["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
    recommended: true,
  },
  {
    id: "facebook",
    name: "Facebook",
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "fb.com", "www.fb.com"],
    recommended: true,
    note: "doesn't include Messenger",
  },
  {
    id: "youtube",
    name: "YouTube",
    hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"],
    recommended: true,
    note: "music.youtube.com stays reachable",
  },
  {
    id: "reddit",
    name: "Reddit",
    hosts: ["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "m.reddit.com", "redd.it"],
    recommended: true,
    note: "the whole site, every subreddit included",
  },
  {
    id: "instagram",
    name: "Instagram",
    hosts: ["instagram.com", "www.instagram.com"],
    recommended: false,
  },
  {
    id: "tiktok",
    name: "TikTok",
    hosts: ["tiktok.com", "www.tiktok.com", "m.tiktok.com"],
    recommended: false,
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    hosts: ["linkedin.com", "www.linkedin.com"],
    recommended: false,
  },
  {
    id: "hackernews",
    name: "Hacker News",
    hosts: ["news.ycombinator.com"],
    recommended: false,
  },
  {
    id: "messenger",
    name: "Messenger",
    hosts: ["messenger.com", "www.messenger.com"],
    recommended: false,
    note: "separate from Facebook so you can keep it",
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id.toLowerCase());
}
