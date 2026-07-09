// SQLite via better-sqlite3 + drizzle — the same stack superset's host-service
// uses in production (packages/host-service/src/db/db.ts). Runs under Node.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>;

const MIGRATIONS_FOLDER = fileURLToPath(
	new URL("../../drizzle", import.meta.url),
);

export function createDb(dbPath: string) {
	mkdirSync(dirname(dbPath), { recursive: true });

	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");

	const db = drizzle(sqlite, { schema });

	try {
		migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	} catch (error) {
		console.error("[db] migration failed:", error);
		throw error;
	}

	// PTYs never survive a restart (no background daemon), so any session row
	// still marked "active" from a previous run is definitionally dead the
	// moment we boot — fix the bookkeeping now rather than leaving the DB
	// claiming a live process that no longer exists. `terminal_agent_bindings`
	// are left untouched: resumeWorkspace still needs their captured
	// agentSessionId to `--resume` the same conversation later.
	db.update(schema.terminalSessions)
		.set({ status: "ended", endedAt: Date.now() })
		.where(eq(schema.terminalSessions.status, "active"))
		.run();

	return db;
}
