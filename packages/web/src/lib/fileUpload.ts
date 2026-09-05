/**
 * 文件 / 文件夹整体上传读取工具（纯前端）。
 *
 * 能力创建支持「上传文件」与「上传文件夹」：浏览器读取后转成
 * `{ path, content, encoding? }[]` 填入表单 files，复用既有的 JSON 提交链路，无需后端 multipart。
 *
 * 编码策略（与后端 asset_files 模型对齐）：
 *   - 文本文件 → content 为原文，encoding 省略。
 *   - 二进制文件 → content 为 base64，encoding = "base64"；安装时由 agent 解码落盘。
 *   - 文件夹的全部内容都会被上传（含图片、字体、可执行脚本等二进制），
 *     仅忽略版本控制 / 依赖目录等噪声，以及超过体积上限的单个文件。
 *   - 文件夹上传通过 <input webkitdirectory> 的 file.webkitRelativePath 还原相对路径，
 *     默认剥掉用户选择的顶层目录名，使路径相对于该目录（如 scripts/foo.py）。
 */

export interface ReadFile {
  path: string;
  content: string;
  /** "base64" 表示 content 是二进制内容的 base64；省略为 UTF-8 文本。 */
  encoding?: "base64";
}

export interface ReadFilesResult {
  files: ReadFile[];
  /** 被跳过的文件及原因（用于 toast 提示） */
  skipped: { path: string; reason: string }[];
}

/** 单文件大小上限：5MB。二进制资源（图片/字体/脚本）足够，避免把超大文件灌进 SQLite。 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 噪声文件 / 目录，整体上传时忽略：版本控制元数据、依赖产物、编辑器/系统垃圾文件。
 * 这些不是能力内容本身，且体积可能极大；其余文件（含所有二进制）一律上传。
 */
const IGNORED =
  /(^|\/)(\.git|\.DS_Store|node_modules|\.svn|\.hg|__pycache__|\.idea|\.vscode)(\/|$)/i;

/** 把 webkitRelativePath 规整为相对路径，可选剥掉顶层目录。 */
function normalizePath(raw: string, stripRoot: boolean): string {
  let p = raw.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (stripRoot) {
    const idx = p.indexOf("/");
    if (idx >= 0) p = p.slice(idx + 1);
  }
  return p;
}

/** 把字节数组编码为 base64（分块拼接，避免 String.fromCharCode 的参数过多 / 爆栈）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 读取单个文件：优先尝试按 UTF-8 文本解码（无 NUL 字节且解码无误），
 * 否则当作二进制并 base64 编码。
 */
function decodeOne(bytes: Uint8Array): { content: string; encoding?: "base64" } {
  if (!bytes.includes(0)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { content: text };
    } catch {
      // 含非法 UTF-8 序列 → 视为二进制
    }
  }
  return { content: bytesToBase64(bytes), encoding: "base64" };
}

/**
 * 读取一组 File 为 `{ path, content, encoding? }[]`。
 *
 * @param fileList   来自 <input type=file> 的 FileList
 * @param stripRoot  文件夹上传时剥掉顶层目录名（默认 true）
 */
export async function readFiles(
  fileList: FileList | File[],
  stripRoot = true,
): Promise<ReadFilesResult> {
  const list = Array.from(fileList);
  const files: ReadFile[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const file of list) {
    const rel = (file as any).webkitRelativePath || file.name;
    const isFolder = !!(file as any).webkitRelativePath;
    const path = normalizePath(rel, isFolder && stripRoot);

    if (!path || IGNORED.test(`/${path}`)) continue;
    if (file.size > MAX_FILE_BYTES) {
      skipped.push({ path, reason: "超过 5MB" });
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      skipped.push({ path, reason: "读取失败" });
      continue;
    }
    const { content, encoding } = decodeOne(bytes);
    files.push({ path, content, ...(encoding ? { encoding } : {}) });
  }

  return { files, skipped };
}
