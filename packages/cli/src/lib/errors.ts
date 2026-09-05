/**
 * 命令层抛出的"用户可见、应导致 CLI 进程非零退出"的错误。
 *
 * 命令实现里只需 `throw new CliFailure("…")`，由 `index.ts` 顶层 catch 转
 * `program.error(msg, { exitCode })`，避免散落各处的 `process.exit(1)`。
 */
export class CliFailure extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "CliFailure";
  }
}

export function fail(message: string, exitCode = 1): never {
  throw new CliFailure(message, exitCode);
}
