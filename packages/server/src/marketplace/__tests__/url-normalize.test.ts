import { describe, it, expect } from "vitest";
import { normalizeRepoUrl } from "../url-normalize.js";

describe("normalizeRepoUrl", () => {
  it("strips .git suffix", () => {
    expect(normalizeRepoUrl("https://github.com/foo/bar.git")).toBe("https://github.com/foo/bar");
  });

  it("lowercases host but keeps path case", () => {
    expect(normalizeRepoUrl("https://GitHub.com/Foo/Bar")).toBe("https://github.com/Foo/Bar");
  });

  it("converts SSH form to HTTPS form", () => {
    expect(normalizeRepoUrl("git@github.com:foo/bar.git")).toBe("https://github.com/foo/bar");
  });

  it("removes trailing slash", () => {
    expect(normalizeRepoUrl("https://github.com/foo/bar/")).toBe("https://github.com/foo/bar");
  });

  it("rejects invalid input", () => {
    expect(() => normalizeRepoUrl("not a url")).toThrow();
    expect(() => normalizeRepoUrl("")).toThrow();
  });

  it("rejects non-HTTPS protocols and credential-bearing URLs", () => {
    expect(() => normalizeRepoUrl("http://gitlab.example.com/x/y")).toThrow();
    expect(() => normalizeRepoUrl("https://user:secret@example.com/x/y")).toThrow();
  });

  it("treats different forms of the same repo as equal", () => {
    const a = normalizeRepoUrl("https://github.com/Foo/Bar.git");
    const b = normalizeRepoUrl("git@github.com:Foo/Bar.git");
    const c = normalizeRepoUrl("https://github.com/Foo/Bar/");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
