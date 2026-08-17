import { describe, expect, it } from "vitest";

import { sanitizeDisplayName } from "../src/security/name.js";

describe("cross-platform display name sanitization", () => {
  it.each([
    ["../../etc/passwd", "_.._etc_passwd"],
    ["folder\\report.pdf", "folder_report.pdf"],
    [" report.txt. ", "report.txt"],
    ["CON", "_CON"],
    ["lpt9.txt", "_lpt9.txt"],
    ["a\u202Eb.txt", "ab.txt"],
    ["a\u0000b\u001fc.txt", "abc.txt"],
    ["", "unnamed"],
    ["...", "unnamed"]
  ])("sanitizes %j to %j", (input, expected) => {
    expect(sanitizeDisplayName(input)).toBe(expected);
  });

  it("bounds names by Unicode code points while retaining an extension", () => {
    const result = sanitizeDisplayName(`${"文".repeat(300)}.pdf`);
    expect([...result].length).toBeLessThanOrEqual(180);
    expect(result.endsWith(".pdf")).toBe(true);
  });
});
