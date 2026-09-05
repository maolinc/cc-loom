/**
 * 密码 schema 单元测试。
 *
 * 不变量:
 * - loginSchema 仅校验非空，不限长度（不向攻击者泄露长度规则）
 * - changePasswordSchema.newPassword 强制 6-128 位
 * - changePasswordSchema.currentPassword 仅校验非空（旧密码可能不满足新策略）
 */
import { describe, it, expect } from "vitest";
import { loginSchema, changePasswordSchema } from "@maolinc/cc-loom-shared";

describe("password schema", () => {
  describe("loginSchema", () => {
    it("拒绝空密码", () => {
      expect(loginSchema.safeParse({ email: "a@b.com", password: "" }).success).toBe(false);
    });

    it("接受任意非空密码（不限长度，长度策略不在登录入口生效）", () => {
      // 5 位、25 位都应通过 schema——是否真正登录成功由 verifyPassword 决定
      expect(loginSchema.safeParse({ email: "a@b.com", password: "wrong" }).success).toBe(true);
      expect(
        loginSchema.safeParse({ email: "a@b.com", password: "x".repeat(25) }).success,
      ).toBe(true);
    });
  });

  describe("changePasswordSchema.newPassword", () => {
    it("拒绝少于 6 位的新密码", () => {
      const r = changePasswordSchema.safeParse({
        currentPassword: "old",
        newPassword: "short",
      });
      expect(r.success).toBe(false);
    });

    it("拒绝超过 128 位的新密码", () => {
      const r = changePasswordSchema.safeParse({
        currentPassword: "old",
        newPassword: "x".repeat(129),
      });
      expect(r.success).toBe(false);
    });

    it("接受 6 位和 128 位边界值", () => {
      expect(
        changePasswordSchema.safeParse({ currentPassword: "old", newPassword: "x".repeat(6) }).success,
      ).toBe(true);
      expect(
        changePasswordSchema.safeParse({
          currentPassword: "old",
          newPassword: "x".repeat(128),
        }).success,
      ).toBe(true);
    });

    it("错误消息提示最小长度", () => {
      const r = changePasswordSchema.safeParse({
        currentPassword: "old",
        newPassword: "123",
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0]?.message ?? "").toContain("6");
      }
    });
  });
});
