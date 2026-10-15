import { domainToASCII } from "node:url";

export class InvalidHostnameError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid hostname '${input}': ${reason}`);
  }
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Names that would break the machine (or do nothing) if pointed at 0.0.0.0.
const RESERVED_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".arpa"];

/**
 * Returns the canonical (lowercase, ASCII, no trailing dot) form of a hostname,
 * or throws InvalidHostnameError explaining why it can't go in /etc/hosts.
 */
export function normalizeHostname(input: string): string {
  const raw = input.trim();
  if (raw === "") throw new InvalidHostnameError(input, "empty");

  if (/[/:?#@\s]/.test(raw)) {
    const suggestion = hostnameFromUrl(raw);
    if (suggestion) {
      throw new InvalidHostnameError(input, `expected a hostname, not a URL. Did you mean '${suggestion}'?`);
    }
    if (raw.includes(":")) {
      throw new InvalidHostnameError(input, "IP addresses and ports can't be blocked; use a hostname");
    }
    throw new InvalidHostnameError(input, "contains characters that aren't allowed in hostnames");
  }
  if (raw.includes("*")) {
    throw new InvalidHostnameError(input, "wildcards aren't supported by /etc/hosts; list each hostname");
  }

  let host = raw.toLowerCase().replace(/\.$/, "");
  if (/[^\x00-\x7f]/.test(host)) {
    host = domainToASCII(host);
    if (host === "") throw new InvalidHostnameError(input, "not a valid internationalized domain name");
  }

  if (host.length > 253) throw new InvalidHostnameError(input, "longer than 253 characters");

  const labels = host.split(".");
  if (labels.length < 2) {
    throw new InvalidHostnameError(input, "must include a domain, e.g. 'example.com'");
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      throw new InvalidHostnameError(
        input,
        label === ""
          ? "contains an empty label (consecutive or leading dots)"
          : `label '${label}' must be 1-63 letters, digits or hyphens and can't start or end with a hyphen`,
      );
    }
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) {
    throw new InvalidHostnameError(input, "IP addresses can't be blocked; use a hostname");
  }
  if (host === "localhost.localdomain" || RESERVED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new InvalidHostnameError(input, "reserved for local use and must not be blocked");
  }

  return host;
}

function hostnameFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.hostname && url.hostname !== raw.toLowerCase() ? normalizeHostname(url.hostname) : null;
  } catch {
    return null;
  }
}
