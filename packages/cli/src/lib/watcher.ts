/**
 * 监视已注册项目的 4 个厂商目录，把 add/unlink/change 事件 debounce 后转给业务层。
 *
 * 选 chokidar 而非 native fs.watch：macOS 下 atomic rename（writeFileAtomic 的实现）
 * 在 fs.watch 上会丢事件，本仓库 installer 大量使用原子写，会导致镜像视图错过自身
 * 触发的更新；chokidar 内置 awaitWriteFinish 与跨平台兜底已是社区标配。
 *
 * 设计要点：
 *  - 一个 watcher 实例统一管理所有项目；按 projectId 分组监视根。
 *  - 监视点 = projectRoot 本身（depth 不限），用 chokidar 的内置 ignored 把
 *    根下非 4 个厂商目录的 sibling 排掉。这样即便某个厂商目录是后建的，也能被
 *    第一次 add 触发出来；不需要先存在才 watch。
 *  - debounce：每个项目独立 500ms 窗口，期间所有事件压成一次回调。
 *  - 错误：watcher 自身的 error 事件不打断流程，只 emit 一次给上层日志。
 */
import chokidar, { type FSWatcher } from "chokidar";
import { TARGET_DIRS, TARGET_TOOLS } from "@maolinc/cc-loom-shared";

const DEBOUNCE_MS = 500;

type ChangeHandler = (projectId: string) => void;
type ErrorHandler = (projectId: string, message: string) => void;

interface Entry {
  projectId: string;
  root: string;
  watcher: FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
}

export class ProjectWatcher {
  private entries = new Map<string, Entry>();
  private changeHandlers: ChangeHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];

  /** 开始监视一个项目；幂等：重复同 projectId 会先 stop 旧的再起新的。 */
  start(projectId: string, projectRoot: string): void {
    void this.stop(projectId);

    // 顶层 4 个厂商目录的绝对路径前缀。chokidar `ignored` 接收 (path) ⇒ boolean。
    // 项目根本身不忽略；其下凡是不属于 4 个厂商目录或允许的根文件（.mcp.json）的
    // 子树都忽略。.mcp.json 是 ClaudeCode adapter 唯一会写到项目根的产物，
    // 镜像把它合并到 claudecode 卡呈现，因此 watcher 也必须监视它，否则用户
    // 外部编辑这个文件 web 端永远收不到通知。
    const allowedPrefixes = TARGET_TOOLS.map((t) => `${projectRoot}/${TARGET_DIRS[t]}`);
    const allowedRootFiles = new Set([`${projectRoot}/.mcp.json`]);
    const isIgnored = (path: string): boolean => {
      if (path === projectRoot) return false;
      // chokidar 在 Windows 给的是反斜杠路径，统一转一下再比对
      const normalized = path.replace(/\\/g, "/");
      const root = projectRoot.replace(/\\/g, "/");
      if (normalized === root) return false;
      // 项目根白名单文件（精确匹配）
      for (const f of allowedRootFiles) {
        if (normalized === f.replace(/\\/g, "/")) return false;
      }
      // 允许：以 root/<vendor> 开头（含子目录与文件）；或恰好等于 root/<vendor>
      for (const prefix of allowedPrefixes) {
        const p = prefix.replace(/\\/g, "/");
        if (normalized === p || normalized.startsWith(`${p}/`)) return false;
      }
      // 直接是 root 的子节点但不是 4 个厂商目录或白名单根文件之一 → 忽略
      return true;
    };

    const watcher = chokidar.watch(projectRoot, {
      ignored: isIgnored,
      ignoreInitial: true, // 启动时不触发已有文件，避免 loom start 一上线就刷一波
      persistent: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      // depth 不限，让 chokidar 一直深入；ignored 决定边界。
    });

    const entry: Entry = { projectId, root: projectRoot, watcher, debounceTimer: null };
    this.entries.set(projectId, entry);

    const trigger = () => {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null;
        for (const h of this.changeHandlers) h(projectId);
      }, DEBOUNCE_MS);
      entry.debounceTimer.unref?.();
    };

    watcher.on("add", trigger);
    watcher.on("addDir", trigger);
    watcher.on("change", trigger);
    watcher.on("unlink", trigger);
    watcher.on("unlinkDir", trigger);
    watcher.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      for (const h of this.errorHandlers) h(projectId, msg);
    });
  }

  async stop(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    this.entries.delete(projectId);
    await entry.watcher.close().catch(() => {
      /* close 在多次调用或 fs 错误时会拒绝；忽略，避免遮蔽业务错误 */
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  /** 注册变更回调；同一处理器多次注册会触发多次。 */
  onChange(handler: ChangeHandler): void {
    this.changeHandlers.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  /** 当前正在监视的 projectId 列表，便于上层 reconcile（项目注册/注销）。 */
  watchedProjects(): string[] {
    return [...this.entries.keys()];
  }
}
