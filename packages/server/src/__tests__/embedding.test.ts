import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { embed, EmbeddingApiError, EmbeddingConfigError } from "../lib/embedding.js";
import { embeddingSettings } from "../lib/embedding-config.js";
import { migrate } from "../db/migrate.js";

// L1：mock globalThis.fetch，验证请求体构造（input_type 随 mode 切换、extra_body
// 透传、encoding_format）、响应解析（按 index 对齐）、批量切片、瞬时错误重试、
// 非瞬时 4xx 不重试。配置走真实临时 DB（beforeAll 建表）。

beforeAll(() => {
  migrate();
});

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function vec(n: number, fill = 0): number[] {
  return Array.from({ length: n }, () => fill);
}

/** 安装 fetch mock，返回 spy 以便断言调用参数。 */
function installFetch(impl: (...args: any[]) => unknown): any {
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl as any);
}

beforeEach(() => {
  embeddingSettings.clear();
  embeddingSettings.update({
    enabled: true,
    baseUrl: "https://embed.example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    dim: 4,
    // 测试用极小退避，避免重试用例变慢
    backoffBaseMs: 1,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function bodyOf(spy: any): Record<string, unknown> {
  const call = spy.mock.calls[0];
  expect(call).toBeDefined();
  const init = call![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("embed 请求体构造（非对称 input_type）", () => {
  it("mode=passage 发送 passageInputType 作为 input_type", async () => {
    embeddingSettings.update({ passageInputType: "passage", queryInputType: "query" });
    const spy = installFetch(async () => mockResponse({
      data: [{ embedding: vec(4, 1), index: 0 }],
    }));

    await embed(["hello"], "passage");

    const body = bodyOf(spy);
    expect(body.input_type).toBe("passage");
    expect(body.input).toEqual(["hello"]);
    expect(body.model).toBe("test-model");
    expect(body.encoding_format).toBe("float");
  });

  it("mode=query 发送 queryInputType 作为 input_type", async () => {
    embeddingSettings.update({ passageInputType: "passage", queryInputType: "query" });
    const spy = installFetch(async () => mockResponse({
      data: [{ embedding: vec(4, 2), index: 0 }],
    }));

    await embed(["搜索词"], "query");
    expect(bodyOf(spy).input_type).toBe("query");
  });

  it("input_type 为空串时不发送该字段（兼容 OpenAI 原生）", async () => {
    embeddingSettings.update({ passageInputType: "", queryInputType: "" });
    const spy = installFetch(async () => mockResponse({
      data: [{ embedding: vec(4), index: 0 }],
    }));

    await embed(["x"], "passage");
    expect(bodyOf(spy).input_type).toBeUndefined();
  });

  it("extraBody 字段透传到请求体", async () => {
    embeddingSettings.update({ extraBody: { truncate: "NONE", user: "u1" } });
    const spy = installFetch(async () => mockResponse({
      data: [{ embedding: vec(4), index: 0 }],
    }));

    await embed(["x"], "passage");
    const body = bodyOf(spy);
    expect(body.truncate).toBe("NONE");
    expect(body.user).toBe("u1");
  });

  it("URL 拼接 /embeddings", async () => {
    const spy = installFetch(async () => mockResponse({
      data: [{ embedding: vec(4), index: 0 }],
    }));

    await embed(["x"], "passage");
    expect(spy.mock.calls[0]![0]).toBe("https://embed.example.com/v1/embeddings");
  });

  it("Authorization 头带 Bearer apiKey", async () => {
    const spy = installFetch(async () => mockResponse({
      data: [{ embedding: vec(4), index: 0 }],
    }));

    await embed(["x"], "passage");
    const init = spy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });
});

describe("embed 响应解析", () => {
  it("按 index 对齐输入顺序（乱序返回）", async () => {
    installFetch(async () => mockResponse({
      data: [
        { embedding: vec(4, 2), index: 1 },
        { embedding: vec(4, 1), index: 0 },
        { embedding: vec(4, 3), index: 2 },
      ],
    }));

    const out = await embed(["a", "b", "c"], "passage");
    expect(out).toHaveLength(3);
    expect(out[0]![0]).toBe(1);
    expect(out[1]![0]).toBe(2);
    expect(out[2]![0]).toBe(3);
  });

  it("向量数与输入不匹配时抛 EmbeddingApiError", async () => {
    installFetch(async () => mockResponse({
      data: [{ embedding: vec(4), index: 0 }],
    }));
    await expect(embed(["a", "b"], "passage")).rejects.toThrow(EmbeddingApiError);
  });

  it("响应缺少 data 数组时抛 EmbeddingApiError", async () => {
    installFetch(async () => mockResponse({}));
    await expect(embed(["a"], "passage")).rejects.toThrow(EmbeddingApiError);
  });
});

describe("embed 批量切片", () => {
  it("按 batchSize 切片多次请求，结果按顺序拼接", async () => {
    embeddingSettings.update({ batchSize: 2 });
    let call = 0;
    installFetch(async (_url, init) => {
      const reqBody = JSON.parse((init as RequestInit).body as string) as { input: string[] };
      const data = reqBody.input.map((_, i) => ({ embedding: vec(4, call * 10 + i), index: i }));
      call++;
      return mockResponse({ data });
    });

    const out = await embed(["a", "b", "c", "d", "e"], "passage");
    expect(out).toHaveLength(5);
    // batch0: a=0,b=1 ; batch1: c=10,d=11 ; batch2: e=20
    expect(out[0]![0]).toBe(0);
    expect(out[1]![0]).toBe(1);
    expect(out[2]![0]).toBe(10);
    expect(out[3]![0]).toBe(11);
    expect(out[4]![0]).toBe(20);
    expect(call).toBe(3);
  });
});

describe("embed 重试与错误处理", () => {
  it("429 瞬时错误：指数退避重试，成功后返回结果", async () => {
    let calls = 0;
    installFetch(async () => {
      calls++;
      if (calls < 3) return mockResponse({ error: { message: "rate limited" } }, 429);
      return mockResponse({ data: [{ embedding: vec(4, 7), index: 0 }] });
    });

    const out = await embed(["x"], "passage", { maxRetries: 2 });
    expect(calls).toBe(3);
    expect(out[0]![0]).toBe(7);
  });

  it("5xx 瞬时错误：重试耗尽后抛 EmbeddingApiError", async () => {
    installFetch(async () => mockResponse({ error: { message: "server error" } }, 503));
    await expect(embed(["x"], "passage", { maxRetries: 1 })).rejects.toThrow(EmbeddingApiError);
  });

  it("400 非瞬时错误：立即抛出，不重试", async () => {
    let calls = 0;
    installFetch(async () => {
      calls++;
      return mockResponse({ error: { message: "bad request" } }, 400);
    });
    await expect(embed(["x"], "passage", { maxRetries: 3 })).rejects.toThrow(EmbeddingApiError);
    expect(calls).toBe(1);
  });

  it("网络错误（fetch reject）：重试后成功", async () => {
    let calls = 0;
    installFetch(async () => {
      calls++;
      if (calls < 2) throw new TypeError("fetch failed");
      return mockResponse({ data: [{ embedding: vec(4, 9), index: 0 }] });
    });
    const out = await embed(["x"], "passage", { maxRetries: 2 });
    expect(calls).toBe(2);
    expect(out[0]![0]).toBe(9);
  });

  it("网络错误重试耗尽：抛 EmbeddingApiError", async () => {
    installFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(embed(["x"], "passage", { maxRetries: 1 })).rejects.toThrow(EmbeddingApiError);
  });
});

describe("embed 配置校验", () => {
  it("未配置 baseUrl/apiKey 时抛 EmbeddingConfigError", async () => {
    embeddingSettings.clear();
    await expect(embed(["x"], "passage")).rejects.toThrow(EmbeddingConfigError);
  });

  it("仅缺 apiKey 时抛 EmbeddingConfigError", async () => {
    embeddingSettings.clear();
    embeddingSettings.update({ baseUrl: "https://embed.example.com/v1" });
    await expect(embed(["x"], "passage")).rejects.toThrow(EmbeddingConfigError);
  });
});
