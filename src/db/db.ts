// SQLite via better-sqlite3 + drizzle, migrated on open. Runs under Node
// (not Bun — better-sqlite3's native binding is built against Node's ABI).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>;

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function createDb(dbPath: string, opts: { reconcile?: boolean } = {}) {
	mkdirSync(dirname(dbPath), { recursive: true });

	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	// The daemon and front-end(s) now open this file concurrently — without a
	// busy timeout, a writer colliding with another process's write throws
	// SQLITE_BUSY immediately instead of waiting. Writes here are small and
	// infrequent, so a generous wait is cheap and avoids surfacing that as a
	// user-facing error.
	sqlite.pragma("busy_timeout = 5000");

	const db = drizzle(sqlite, { schema });

	try {
		migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	} catch (error) {
		console.error("[db] migration failed:", error);
		throw error;
	}

	// PTYs now live in the daemon, not whichever process opens the DB — a
	// front-end restarting must NOT touch this, or it would mark the
	// daemon's still-live sessions "ended" out from under it. Only the daemon
	// (the one process that actually owns PTY lifecycle, and whose own
	// restart really does mean every session died) opts in.
	// `terminal_agent_bindings` are left untouched either way: resumeWorkspace
	// still needs their captured agentSessionId to `--resume` later.
	if (opts.reconcile) {
		db.update(schema.terminalSessions)
			.set({ status: "ended", endedAt: Date.now() })
			.where(eq(schema.terminalSessions.status, "active"))
			.run();
	}

	return db;
}
