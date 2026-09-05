const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"]);

interface Props {
  content: string;
  fileName?: string;
  language?: string;
  loading?: boolean;
  /**
   * 抑制内部那条 fileName 顶部 bar。
   * 当父组件已经在外面把路径/文件名画在更显眼的位置时（如 PreviewPanel），
   * 内部再画一条等于重复展示，传 true 隐藏。
   */
  hideName?: boolean;
}

export default function ContentViewer({ content, fileName, loading, hideName }: Props) {
  const ext = fileName ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  const isImage = IMAGE_EXTS.has(ext);

  return (
    <div className="h-full flex flex-col">
      {fileName && !hideName && (
        <div className="px-4 py-2 border-b border-surface-sunken text-xs text-text-muted font-mono bg-surface-card/50 shrink-0">
          {fileName}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            加载中…
          </div>
        ) : isImage ? (
          <div className="flex items-center justify-center h-full">
            <img
              src={content}
              alt={fileName ?? ""}
              className="max-w-full max-h-full object-contain rounded-lg"
            />
          </div>
        ) : (
          <pre className="text-sm text-text-secondary whitespace-pre-wrap font-mono p-4 overflow-x-auto h-full">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
