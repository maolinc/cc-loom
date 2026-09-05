/**
 * YAML frontmatter 解析（极简：仅 key: value / 数组 / `|`/`>` 块标量）。
 *
 * 抽自 marketplace/providers/generic-git.ts，供导入链路与语义搜索字段构造复用
 * （docs/sqlite-vec-search-design.md §2.3「frontmatter 解析复用项目现有逻辑，同源」）。
 */

export interface Frontmatter {
  description?: string;
  tags?: string[];
  name?: string;
}

export const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { fm: {}, body: raw };
  const fm: Frontmatter = {};
  const body = m[2] ?? "";

  const lines = (m[1] ?? "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const idx = line.indexOf(":");
    if (idx === -1 || /^\s/.test(line)) { i++; continue; }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (value === "|" || value === ">") {
      const folded = value === ">";
      i++;
      const collected: string[] = [];
      while (i < lines.length && /^\s/.test(lines[i]!)) {
        collected.push(lines[i]!.replace(/^\s+/, ""));
        i++;
      }
      (fm as any)[key] = folded ? collected.join(" ") : collected.join("\n");
      continue;
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      const arr = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      (fm as any)[key] = arr;
    } else {
      value = value.replace(/^["']|["']$/g, "");
      (fm as any)[key] = value;
    }
    i++;
  }
  return { fm, body };
}
