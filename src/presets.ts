import type { FocusSection, ParsedSection } from "./hosts.ts";

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
    // The web app is served from a cached service worker, so the API hosts must be blocked too.
    hosts: [
      "x.com",
      "www.x.com",
      "mobile.x.com",
      "api.x.com",
      "twitter.com",
      "www.twitter.com",
      "mobile.twitter.com",
      "api.twitter.com",
    ],
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

// Preset hostnames as shipped in 0.1.0, which didn't record presets in the hosts file.
// Only presets whose list has changed since then need an entry.
const V0_1_0_HOSTS: Record<string, string[]> = {
  x: ["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
};

export function findPreset(id: string, catalog = PRESETS): Preset | undefined {
  return catalog.find((preset) => preset.id === id.toLowerCase());
}

/**
 * Rebuilds every preset group from the catalog, so presets pick up hosts added
 * (or drop hosts removed) in newer versions. A preset that no longer exists has
 * its hosts kept as sites, and sites already covered by a preset are dropped.
 */
export function syncSection(section: ParsedSection | FocusSection, catalog = PRESETS): FocusSection {
  const adopted = "legacy" in section && section.legacy ? adoptLegacy(section, catalog) : section;
  const sites = [...adopted.sites];
  const ids = new Set<string>();
  for (const group of adopted.presets) {
    if (findPreset(group.id, catalog)) ids.add(group.id);
    else sites.push(...group.hosts);
  }
  return withPresets({ ...adopted, sites }, [...ids], catalog);
}

/** Returns the section with exactly the given presets enabled, in catalog order. */
export function withPresets(section: FocusSection | null, ids: string[], catalog = PRESETS): FocusSection {
  const presets = catalog
    .filter((preset) => ids.includes(preset.id))
    .map((preset) => ({ id: preset.id, hosts: [...preset.hosts] }));
  const covered = new Set(presets.flatMap((group) => group.hosts));
  return {
    state: section?.state ?? "on",
    presets,
    sites: [...new Set(section?.sites ?? [])].filter((host) => !covered.has(host)),
  };
}

/** The enabled preset that blocks `host`, if any. */
export function presetBlocking(section: FocusSection | null, host: string, catalog = PRESETS): Preset | undefined {
  const group = section?.presets.find((candidate) => candidate.hosts.includes(host));
  return group && findPreset(group.id, catalog);
}

// focus 0.1.0 wrote preset hosts as plain sites. Any preset whose hosts (current
// or 0.1.0 list) are all present was added by `init`, so record it as that preset.
function adoptLegacy(section: FocusSection, catalog: Preset[]): FocusSection {
  const sites = new Set(section.sites);
  const adopted = catalog.filter((preset) =>
    [preset.hosts, V0_1_0_HOSTS[preset.id]].some((hosts) => hosts && hosts.every((host) => sites.has(host))),
  );
  const ids = adopted.map((preset) => preset.id);
  return {
    state: section.state,
    presets: [...section.presets, ...ids.map((id) => ({ id, hosts: [] }))],
    sites: section.sites.filter(
      (host) => !adopted.some((preset) => preset.hosts.includes(host) || V0_1_0_HOSTS[preset.id]?.includes(host)),
    ),
  };
}
