import { createHash, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../db/index.js";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith("scrypt$")) {
    const [, nText, rText, pText, saltHex, hashHex] = stored.split("$");
    const N = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    if (expected.length !== 64) return false;
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  }

  // Pre-release builds stored passwords as salt:sha256. Keep this read path so
  // users can sign in once and be transparently upgraded to scrypt.
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const computed = Buffer.from(createHash("sha256")
    .update(salt + password)
    .digest("hex"), "hex");
  return expected.length === computed.length && timingSafeEqual(computed, expected);
}

export function needsPasswordRehash(stored: string): boolean {
  return !stored.startsWith("scrypt$16384$8$1$");
}

export function generateToken(): string {
  return `prsm_${randomBytes(24).toString("hex")}`;
}

export function generateId(): string {
  return randomBytes(16).toString("hex");
}

// ============ Secret 加密（环境变量密钥 / 用户 AI Key 存储）============
//
// AES-256-GCM。主密钥随机生成后存放在 dataDir/master.key（0600），脱离 DB 单独
// 保存——DB 单独泄漏不直接泄密。首次调用时幂等生成。
//
// 用于：env_vars.value_cipher、user_ai_settings.api_key_cipher。
//
// 取舍：这是单用户本地工具，主密钥与 DB 同机存放，无法抵御拿到完整文件系统
// 的攻击者；但相比明文存储已是严格升级，满足"加密存储、下发时解密"的产品要求。

const MASTER_KEY_PATH = join(dataDir, "master.key");
const MASTER_KEY_LEN = 32; // AES-256

let cachedMasterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  if (!existsSync(MASTER_KEY_PATH)) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const raw = randomBytes(MASTER_KEY_LEN);
    writeFileSync(MASTER_KEY_PATH, raw, { mode: 0o600 });
    try { chmodSync(MASTER_KEY_PATH, 0o600); } catch { /* 非 POSIX 忽略 */ }
  }
  const raw = readFileSync(MASTER_KEY_PATH);
  // 兼容历史/手改：长度不对时派生一份稳定密钥，避免崩溃。
  cachedMasterKey = raw.length === MASTER_KEY_LEN
    ? raw
    : scryptSync(raw, "loom-master-salt", MASTER_KEY_LEN);
  return cachedMasterKey;
}

/**
 * 加密一个 secret，返回自包含的密文字符串：`<iv>:<tag>:<cipher>`（均 hex）。
 * 解密时无需额外参数。
 */
export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/** 解密 encryptSecret 产出的密文。密钥不匹配或被篡改时抛错。 */
export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("密文格式不合法");
  const ivHex = parts[0]!;
  const tagHex = parts[1]!;
  const encHex = parts[2]!;
  const key = getMasterKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
  return dec.toString("utf8");
}
