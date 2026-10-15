import { describe, expect, test } from "bun:test";
import { HostsFormatError, readSection, renderSection, writeSection } from "../src/hosts.ts";

const MAC_DEFAULT = `##
# Host Database
#
# localhost is used to configure the loopback interface
# when the system is booting.  Do not change this entry.
##
127.0.0.1\tlocalhost
255.255.255.255\tbroadcasthost
::1             localhost
`;

const on = (...hosts: string[]) => ({ state: "on" as const, hosts });
const off = (...hosts: string[]) => ({ state: "off" as const, hosts });

describe("readSection", () => {
  test("returns null when there is no focus section", () => {
    expect(readSection(MAC_DEFAULT)).toBeNull();
    expect(readSection("")).toBeNull();
  });

  test("round-trips what writeSection wrote", () => {
    expect(readSection(writeSection(MAC_DEFAULT, on("a.com", "www.a.com")))).toEqual(on("a.com", "www.a.com"));
    expect(readSection(writeSection(MAC_DEFAULT, off("a.com")))).toEqual(off("a.com"));
  });

  test("infers state from entries when the state line is missing", () => {
    expect(readSection("# BEGIN focus\n0.0.0.0 a.com\n# END focus\n")).toEqual(on("a.com"));
    expect(readSection("# BEGIN focus\n# 0.0.0.0 a.com\n# END focus\n")).toEqual(off("a.com"));
  });

  test.each([
    ["BEGIN without END", "# BEGIN focus\n0.0.0.0 a.com\n"],
    ["END without BEGIN", "0.0.0.0 a.com\n# END focus\n"],
    ["END before BEGIN", "# END focus\n# BEGIN focus\n"],
    ["two sections", "# BEGIN focus\n# END focus\n# BEGIN focus\n# END focus\n"],
    ["a foreign entry inside", "# BEGIN focus\n127.0.0.1 a.com\n# END focus\n"],
    ["an invalid hostname inside", "# BEGIN focus\n0.0.0.0 localhost\n# END focus\n"],
  ])("rejects %s", (_, content) => {
    expect(() => readSection(content)).toThrow(HostsFormatError);
  });
});

describe("renderSection", () => {
  test("blocks each host over IPv4 and IPv6", () => {
    expect(renderSection(on("a.com"))).toEqual([
      "# BEGIN focus",
      "# Managed by the focus CLI. To undo by hand, delete every line from BEGIN to END.",
      "# state: on",
      "0.0.0.0 a.com",
      ":: a.com",
      "# END focus",
    ]);
  });

  test("comments entries out when off", () => {
    expect(renderSection(off("a.com")).slice(2, 5)).toEqual(["# state: off", "# 0.0.0.0 a.com", "# :: a.com"]);
  });
});

describe("writeSection", () => {
  test("appends to the end and leaves existing content byte-for-byte intact", () => {
    const updated = writeSection(MAC_DEFAULT, on("a.com"));
    expect(updated.startsWith(MAC_DEFAULT)).toBe(true);
    expect(updated.slice(MAC_DEFAULT.length)).toBe(renderSection(on("a.com")).join("\n") + "\n");
  });

  test("removing every host restores the original file exactly", () => {
    let content = writeSection(MAC_DEFAULT, on("a.com", "b.com"));
    content = writeSection(content, off("a.com", "b.com"));
    content = writeSection(content, on("a.com"));
    expect(writeSection(content, on())).toBe(MAC_DEFAULT);
    expect(writeSection(content, null)).toBe(MAC_DEFAULT);
  });

  test("turning off and on again is a no-op", () => {
    const blocked = writeSection(MAC_DEFAULT, on("a.com"));
    expect(writeSection(writeSection(blocked, off("a.com")), on("a.com"))).toBe(blocked);
  });

  test("replaces the section in place without touching lines after it", () => {
    const content = `${MAC_DEFAULT}# BEGIN focus\n0.0.0.0 a.com\n# END focus\n10.0.0.5 nas.home.arpa\n`;
    const updated = writeSection(content, on("b.com"));
    expect(updated.startsWith(MAC_DEFAULT)).toBe(true);
    expect(updated.endsWith("# END focus\n10.0.0.5 nas.home.arpa\n")).toBe(true);
    expect(readSection(updated)).toEqual(on("b.com"));
    expect(writeSection(updated, null)).toBe(`${MAC_DEFAULT}10.0.0.5 nas.home.arpa\n`);
  });

  test("adds a newline before the section when the file lacks a trailing one", () => {
    const updated = writeSection("127.0.0.1 localhost", on("a.com"));
    expect(updated.startsWith("127.0.0.1 localhost\n# BEGIN focus\n")).toBe(true);
    expect(writeSection(updated, null)).toBe("127.0.0.1 localhost\n");
  });

  test("handles an empty file", () => {
    const updated = writeSection("", on("a.com"));
    expect(readSection(updated)).toEqual(on("a.com"));
    expect(writeSection(updated, null)).toBe("");
  });

  test("keeps CRLF line endings", () => {
    const content = "127.0.0.1 localhost\r\n";
    const updated = writeSection(content, on("a.com"));
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
    expect(writeSection(writeSection(updated, off("a.com")), on("a.com"))).toBe(updated);
    expect(writeSection(updated, null)).toBe(content);
  });

  test("is a no-op when there is no section to remove", () => {
    expect(writeSection(MAC_DEFAULT, null)).toBe(MAC_DEFAULT);
  });
});
