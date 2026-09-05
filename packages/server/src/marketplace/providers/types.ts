import type { ProviderResult, SourceKind } from "@maolinc/cc-loom-shared";

export interface ProviderParseContext {
  /** Normalized URL of the source whose clone is being parsed. */
  repoUrl?: string;
}

export interface SourceProvider {
  /** stable kind identifier */
  readonly kind: SourceKind;

  /**
   * Parse the local clone directory and return imported assets/plugins.
   * Pure function: must NOT touch DB or network beyond reading files in `localPath`.
   */
  parse(localPath: string, context?: ProviderParseContext): Promise<ProviderResult>;
}
