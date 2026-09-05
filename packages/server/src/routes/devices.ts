import type { FastifyInstance } from "fastify";
import type { Device } from "@maolinc/cc-loom-shared";
import { db } from "../db/index.js";
import { generateId } from "../lib/crypto.js";
import { requireCliAuth, requireAnyAuth } from "../lib/auth.js";

/**
 * 把 SQLite 行（snake_case）映射到 shared 包的 `Device`（camelCase）。
 * 所有对外暴露 device 字段的地方走这一个函数，避免接口形状漂移。
 */
function rowToDevice(row: any): Device {
  return {
    id: row.id,
    userId: row.user_id,
    deviceName: row.device_name,
    status: row.status,
    lastOnlineAt: row.last_online_at,
    createdAt: row.created_at,
  };
}

export function deviceRoutes(app: FastifyInstance) {
  app.get("/api/devices", { preHandler: [requireAnyAuth] }, async (request, reply) => {

    const rows = db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY last_online_at DESC").all(request.user!.userId) as any[];
    return { success: true, data: rows.map(rowToDevice) };
  });

  app.post("/api/devices/register", { preHandler: [requireCliAuth] }, async (request, reply) => {
    const body = request.body as { deviceName?: string };
    const deviceName = body.deviceName || "unknown";
    const now = new Date().toISOString();
    const id = generateId();

    db.prepare(
      "INSERT INTO devices (id, user_id, device_name, status, last_online_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, request.user!.userId, deviceName, "online", now, now);

    const row = db.prepare("SELECT * FROM devices WHERE id = ?").get(id);
    return { success: true, data: rowToDevice(row) };
  });

  app.put("/api/devices/:id/heartbeat", { preHandler: [requireCliAuth] }, async (request, reply) => {
    const device = db.prepare("SELECT * FROM devices WHERE id = ?").get((request.params as any).id) as any;
    if (!device || device.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "设备不存在" });
    }

    db.prepare("UPDATE devices SET status = 'online', last_online_at = ? WHERE id = ?").run(
      new Date().toISOString(), device.id
    );

    return { success: true };
  });
}
