import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import {
  migrate,
  migrateCapabilitySetTerminology,
  migrateLegacyProjectSubscriptions,
} from "../db/migrate.js";

describe("migrateCapabilitySetTerminology", () => {
  it("preserves legacy capability sets, memberships, and project references", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE workspace_assets (workspace_id TEXT NOT NULL, asset_id TEXT NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, current_workspace_id TEXT);
      CREATE TABLE project_subscriptions (project_id TEXT NOT NULL, workspace_id TEXT);
      CREATE TABLE project_subscription_excludes (project_id TEXT NOT NULL, workspace_id TEXT, asset_id TEXT NOT NULL);

      CREATE INDEX idx_workspaces_source ON workspaces(name);
      CREATE INDEX idx_projects_workspace ON projects(current_workspace_id);
      CREATE INDEX idx_workspace_assets_ws ON workspace_assets(workspace_id);
      CREATE INDEX idx_subscriptions_workspace ON project_subscriptions(workspace_id);

      INSERT INTO workspaces VALUES ('set-1', 'Team baseline');
      INSERT INTO workspace_assets VALUES ('set-1', 'asset-1');
      INSERT INTO projects VALUES ('project-1', 'set-1');
      INSERT INTO project_subscriptions VALUES ('project-1', 'set-1');
      INSERT INTO project_subscription_excludes VALUES ('project-1', 'set-1', 'asset-2');
    `);

    migrateCapabilitySetTerminology(database);
    migrateCapabilitySetTerminology(database);

    const tableNames = (database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(tableNames).toContain("capability_sets");
    expect(tableNames).toContain("capability_set_assets");
    expect(tableNames).not.toContain("workspaces");
    expect(tableNames).not.toContain("workspace_assets");

    const columns = (table: string) => (
      database.pragma(`table_info(${table})`) as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(columns("projects")).toContain("current_capability_set_id");
    expect(columns("project_subscriptions")).toContain("capability_set_id");
    expect(columns("project_subscription_excludes")).toContain("capability_set_id");
    expect(columns("capability_set_assets")).toContain("capability_set_id");

    expect(database.prepare("SELECT id, name FROM capability_sets").get()).toEqual({
      id: "set-1",
      name: "Team baseline",
    });
    expect(database.prepare("SELECT capability_set_id, asset_id FROM capability_set_assets").get()).toEqual({
      capability_set_id: "set-1",
      asset_id: "asset-1",
    });
    expect(database.prepare("SELECT current_capability_set_id FROM projects").get()).toEqual({
      current_capability_set_id: "set-1",
    });
    expect(database.prepare("SELECT project_id, capability_set_id FROM project_subscriptions").get()).toEqual({
      project_id: "project-1",
      capability_set_id: "set-1",
    });
    expect(database.prepare(
      "SELECT project_id, capability_set_id, asset_id FROM project_subscription_excludes",
    ).get()).toEqual({
      project_id: "project-1",
      capability_set_id: "set-1",
      asset_id: "asset-2",
    });

    const legacyIndexes = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%workspace%'",
    ).all();
    expect(legacyIndexes).toEqual([]);
    database.close();
  });

  it("moves the legacy project selection and policy into subscriptions", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE capability_sets (id TEXT PRIMARY KEY, target_tools TEXT NOT NULL);
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        registered_at TEXT NOT NULL,
        default_targets TEXT NOT NULL,
        current_capability_set_id TEXT,
        sync_policy TEXT NOT NULL
      );
      CREATE TABLE project_subscriptions (
        project_id TEXT NOT NULL,
        capability_set_id TEXT NOT NULL,
        sync_policy TEXT NOT NULL,
        target_tools TEXT,
        installed_at TEXT NOT NULL,
        PRIMARY KEY (project_id, capability_set_id)
      );
      INSERT INTO capability_sets VALUES ('set-1', '["cursor"]');
      INSERT INTO projects VALUES (
        'project-1', '2026-01-01T00:00:00.000Z', '["cursor","codex"]', 'set-1', 'locked'
      );
    `);

    migrateLegacyProjectSubscriptions(database);

    expect(database.prepare(`
      SELECT capability_set_id, sync_policy, target_tools, installed_at
      FROM project_subscriptions ORDER BY capability_set_id
    `).all()).toEqual([
      {
        capability_set_id: "",
        sync_policy: "locked",
        target_tools: null,
        installed_at: "2026-01-01T00:00:00.000Z",
      },
      {
        capability_set_id: "set-1",
        sync_policy: "locked",
        target_tools: '["cursor"]',
        installed_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const projectColumns = (
      database.pragma("table_info(projects)") as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(projectColumns).not.toContain("current_capability_set_id");
    expect(projectColumns).not.toContain("sync_policy");
    database.close();
  });

  it("uses subscriptions as the only capability set relationship on fresh installs", () => {
    migrate();

    const projectColumns = (db.pragma("table_info(projects)") as Array<{ name: string }>).map(({ name }) => name);
    expect(projectColumns).not.toContain("current_workspace_id");
    expect(projectColumns).not.toContain("current_capability_set_id");
    expect(projectColumns).not.toContain("sync_policy");

    const subscriptionColumns = (
      db.pragma("table_info(project_subscriptions)") as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(subscriptionColumns).toContain("capability_set_id");
    expect(subscriptionColumns).toContain("sync_policy");
  });
});
