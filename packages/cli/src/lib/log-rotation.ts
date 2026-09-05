/**
 * 按文件大小切分的日志写入器。
 *
 * 模型很简单：维护一个 append 写流，写入后累计字节，
 * 超过 maxBytes 就把当前文件改名为 `.1`，原 `.k` 改名为 `.k+1`，
 * 最老的 `.maxFiles` 直接删除，然后重开一个新的 stream。
 *
 * 因为 daemon 子进程是唯一写入者，无需加锁。
 */
import {
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";

export interface RotatorOptions {
  /** 当前日志文件路径，例如 ~/.loom/logs/agent.log */
  filepath: string;
  /** 触发滚动的字节阈值。默认 5MB。 */
  maxBytes?: number;
  /** 保留的历史文件数量（不含当前）。默认 5。 */
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export class RotatingFileWriter {
  private stream: WriteStream;
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(private readonly opts: RotatorOptions) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.bytes = existsSync(opts.filepath) ? statSync(opts.filepath).size : 0;
    this.stream = createWriteStream(opts.filepath, { flags: "a" });
  }

  write(line: string): void {
    if (!line.endsWith("\n")) line += "\n";
    const buf = Buffer.from(line, "utf-8");
    this.stream.write(buf);
    this.bytes += buf.length;
    if (this.bytes >= this.maxBytes) this.rotate();
  }

  close(): void {
    this.stream.end();
  }

  private rotate(): void {
    this.stream.end();
    const { filepath } = this.opts;

    // 删最老的
    const oldest = `${filepath}.${this.maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);

    // 倒序往后挪：.k → .(k+1)
    for (let k = this.maxFiles - 1; k >= 1; k--) {
      const src = `${filepath}.${k}`;
      const dst = `${filepath}.${k + 1}`;
      if (existsSync(src)) renameSync(src, dst);
    }

    // 当前 → .1
    if (existsSync(filepath)) renameSync(filepath, `${filepath}.1`);

    // 重开
    this.stream = createWriteStream(filepath, { flags: "a" });
    this.bytes = 0;
  }
}
