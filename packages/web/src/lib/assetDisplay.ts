import type { Asset } from "@maolinc/cc-loom-shared";

/**
 * 主展示名：始终使用能力的正式名称 `name`（名称为主）。
 */
export function assetDisplayName(asset: Pick<Asset, "name">): string {
  return asset.name;
}

/**
 * 辅助展示名（灰色，别名为辅）：存在别名时返回别名，否则 null。
 * 用于在名称旁以次要样式展示别名。
 */
export function assetAliasName(asset: Pick<Asset, "alias">): string | null {
  return asset.alias?.trim() || null;
}

/** 将邮箱格式的作者名去掉 @domain 部分，只显示用户名。 */
export function formatAuthorName(email: string | null | undefined): string {
  if (!email) return "";
  return email.includes("@") ? email.split("@")[0]! : email;
}
