// Singleton app-wide preferences (default agent CLI + default editor). One
// row, id fixed at 1 — created on first read if missing.
import { eq } from "drizzle-orm";
import type { Db } from "../db/db.ts";
import { type AgentType, type EditorType, hostSettings } from "../db/schema.ts";

export interface HostSettings {
	defaultAgent: AgentType;
	defaultEditor: EditorType;
	/** The workspace either front end reopens on its next launch, or null. */
	lastOpenedWorkspaceId: string | null;
}

const SETTINGS_ROW_ID = 1;

export function getHostSettings(db: Db): HostSettings {
	const row = db.select().from(hostSettings).where(eq(hostSettings.id, SETTINGS_ROW_ID)).get();
	if (row) {
		return {
			defaultAgent: row.defaultAgent,
			defaultEditor: row.defaultEditor,
			lastOpenedWorkspaceId: row.lastOpenedWorkspaceId,
		};
	}

	const defaults: HostSettings = {
		defaultAgent: "claude",
		defaultEditor: "vscode",
		lastOpenedWorkspaceId: null,
	};
	db.insert(hostSettings)
		.values({ id: SETTINGS_ROW_ID, ...defaults })
		.run();
	return defaults;
}

export function updateHostSettings(db: Db, patch: Partial<HostSettings>): HostSettings {
	const current = getHostSettings(db);
	const next = { ...current, ...patch };
	db.update(hostSettings).set(next).where(eq(hostSettings.id, SETTINGS_ROW_ID)).run();
	return next;
}
