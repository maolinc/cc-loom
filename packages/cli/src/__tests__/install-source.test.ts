import { describe, expect, it, vi, afterEach } from "vitest";

// `loom update` 安装来源探测：从已安装包 package.json 的 _from/_resolved
// 恢复 registry 与 dist-tag，避免私有源用户被公网同名包顶替。
// 此处覆盖两个纯解析函数的边界，以及 resolveInstallSource 的整合路径。

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("node:url", () => ({ fileURLToPath: vi.fn(() => "/fake/loom/package.json") }));

import { readFileSync } from "node:fs";
import { parseRegistry, parseTag, resolveInstallSource } from "../lib/install-source.js";

const readMock = readFileSync as unknown as ReturnType<typeof vi.fn>;

afterEach(() => { readMock.mockReset(); });

describe("parseRegistry", () => {
  it("从无 scope tarball URL 截取 registry origin", () => {
    expect(parseRegistry("http://host:4873/loom/-/loom-0.1.0.tgz"))
      .toBe("http://host:4873");
  });

  it("scoped tarball 保留 registry 的路径前缀", () => {
    expect(parseRegistry("https://npm.example.com/registry/@maolinc/cc-loom/-/cli-1.2.3.tgz"))
      .toBe("https://npm.example.com/registry");
  });

  it("无 /loom/-/ 标记时退到 URL origin", () => {
    expect(parseRegistry("https://registry.npmjs.org/some-other.tgz"))
      .toBe("https://registry.npmjs.org");
  });

  it("非 URL 返回 null", () => {
    expect(parseRegistry("not-a-url")).toBeNull();
  });

  it("空串返回 null", () => {
    expect(parseRegistry("")).toBeNull();
  });
});

describe("parseTag", () => {
  it("name@tag → tag", () => {
    expect(parseTag("loom@dev")).toBe("dev");
    expect(parseTag("loom@latest")).toBe("latest");
    expect(parseTag("loom@beta.1")).toBe("beta.1");
  });

  it("scoped name@tag → tag", () => {
    expect(parseTag("@maolinc/cc-loom@dev")).toBe("dev");
  });

  it("name@version → null（更新应取 latest）", () => {
    expect(parseTag("loom@0.1.0")).toBeNull();
    expect(parseTag("loom@1.2.3-beta.1")).toBeNull();
  });

  it("name@range → null", () => {
    expect(parseTag("loom@^1.0.0")).toBeNull();
    expect(parseTag("loom@~2.3.0")).toBeNull();
    expect(parseTag("loom@>=1.0.0")).toBeNull();
  });

  it("无 @ → null", () => {
    expect(parseTag("loom")).toBeNull();
  });

  it("file:/ github: git+ https:// → null", () => {
    expect(parseTag("file:../loom")).toBeNull();
    expect(parseTag("github:user/repo")).toBeNull();
    expect(parseTag("git+https://github.com/u/r.git")).toBeNull();
    expect(parseTag("https://example.com/loom.tgz")).toBeNull();
  });
});

describe("resolveInstallSource", () => {
  function pkg(obj: Record<string, unknown>): void {
    readMock.mockReturnValue(JSON.stringify(obj));
  }

  it("同时有 _from(tag) 与 _resolved → 返回来源", () => {
    pkg({
      _from: "@maolinc/cc-loom@dev",
      _resolved: "http://registry.example.test:4873/@maolinc/cc-loom/-/cli-0.1.0.tgz",
    });
    expect(resolveInstallSource()).toEqual({
      registry: "http://registry.example.test:4873",
      tag: "dev",
      spec: "@maolinc/cc-loom@dev",
    });
  });

  it("_from 是 version → null（更新应取 latest）", () => {
    pkg({ _from: "@maolinc/cc-loom@0.1.0", _resolved: "http://h/@maolinc/cc-loom/-/cli-0.1.0.tgz" });
    expect(resolveInstallSource()).toBeNull();
  });

  it("缺 _from → null", () => {
    pkg({ _resolved: "http://h/@maolinc/cc-loom/-/cli-0.1.0.tgz" });
    expect(resolveInstallSource()).toBeNull();
  });

  it("缺 _resolved → null", () => {
    pkg({ _from: "@maolinc/cc-loom@dev" });
    expect(resolveInstallSource()).toBeNull();
  });

  it("读文件失败 → null", () => {
    readMock.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(resolveInstallSource()).toBeNull();
  });

  it("package.json 无 _from/_resolved（源码开发态）→ null", () => {
    pkg({ name: "loom", version: "0.1.0" });
    expect(resolveInstallSource()).toBeNull();
  });
});
