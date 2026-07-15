import { useEffect, useState } from "react";
import type { AgentType, EditorType, HostSettings } from "../../lib/api";
import {
	getPermissionState,
	isNotificationsEnabled,
	type NotificationPermissionState,
	requestPermission,
	setNotificationsEnabled,
} from "../../lib/notifications";

// Only Claude Code is verified against a live install and reports live status
// via hooks. The rest are wired up from each tool's docs but unverified against
// a real CLI — flagged experimental so expectations are honest.
const AGENT_OPTIONS: { id: AgentType; label: string; experimental?: boolean }[] = [
	{ id: "claude", label: "Claude Code" },
	{ id: "gemini", label: "Gemini CLI", experimental: true },
	{ id: "codex", label: "Codex", experimental: true },
	{ id: "cursor-agent", label: "Cursor Agent", experimental: true },
	{ id: "droid", label: "Droid", experimental: true },
	{ id: "opencode", label: "OpenCode", experimental: true },
	{ id: "copilot", label: "GitHub Copilot", experimental: true },
];

const EDITOR_OPTIONS: { id: EditorType; label: string }[] = [
	{ id: "vscode", label: "VS Code" },
	{ id: "cursor", label: "Cursor" },
	{ id: "zed", label: "Zed" },
];

interface SettingsModalProps {
	settings: HostSettings;
	busy: boolean;
	error: string | null;
	orphanCount: number | null;
	liveSessionCount: number | null;
	onSave: (patch: Partial<HostSettings>) => Promise<void>;
	onCleanupOrphans: () => void;
	onStopAllAgents: () => void;
	onClose: () => void;
}

export function SettingsModal({
	settings,
	busy,
	error,
	orphanCount,
	liveSessionCount,
	onSave,
	onCleanupOrphans,
	onStopAllAgents,
	onClose,
}: SettingsModalProps) {
	const [defaultAgent, setDefaultAgent] = useState<AgentType>(settings.defaultAgent);
	const [defaultEditor, setDefaultEditor] = useState<EditorType>(settings.defaultEditor);
	const [notificationsOn, setNotificationsOn] = useState(isNotificationsEnabled());
	const [permissionState, setPermissionState] = useState<NotificationPermissionState>(
		getPermissionState(),
	);

	async function handleToggleNotifications() {
		if (notificationsOn) {
			setNotificationsEnabled(false);
			setNotificationsOn(false);
			return;
		}
		const granted = await requestPermission();
		setPermissionState(getPermissionState());
		if (granted) {
			setNotificationsEnabled(true);
			setNotificationsOn(true);
		}
	}

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape" && !busy) onClose();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [busy, onClose]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (busy) return;
		await onSave({ defaultAgent, defaultEditor });
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop — click-outside is a mouse convenience; Escape-to-close is handled by the modal's own keydown listener
		// biome-ignore lint/a11y/useKeyWithClickEvents: as above — Escape closes the modal; the backdrop click is mouse-only
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
			onClick={(e) => {
				if (e.target === e.currentTarget && !busy) onClose();
			}}
		>
			<div className="w-full max-w-md rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg">
				<h2 className="mb-1 text-sm font-semibold">Settings</h2>
				<p className="mb-3 text-xs text-muted-foreground">
					Defaults for new workspaces. Existing workspaces keep whatever they were created with.
				</p>
				<form onSubmit={handleSubmit}>
					<span className="mb-1 block text-xs font-medium text-muted-foreground">Agent</span>
					<select
						value={defaultAgent}
						onChange={(e) => setDefaultAgent(e.target.value as AgentType)}
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					>
						{AGENT_OPTIONS.map((o) => (
							<option key={o.id} value={o.id}>
								{o.label}
								{o.experimental ? " (experimental)" : ""}
							</option>
						))}
					</select>
					{defaultAgent !== "claude" && (
						<p className="mt-1 text-xs text-muted-foreground">
							<span className="font-medium">Experimental.</span>{" "}
							{AGENT_OPTIONS.find((o) => o.id === defaultAgent)?.label}'s launch flags are set from
							its docs but not verified against a live install, and only Claude Code reports live
							status via hooks — other agents just show "working" until the session ends.
						</p>
					)}

					<span className="mt-3 mb-1 block text-xs font-medium text-muted-foreground">Editor</span>
					<select
						value={defaultEditor}
						onChange={(e) => setDefaultEditor(e.target.value as EditorType)}
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					>
						{EDITOR_OPTIONS.map((o) => (
							<option key={o.id} value={o.id}>
								{o.label}
							</option>
						))}
					</select>

					<div className="mt-4 border-t border-border pt-3">
						<span className="mb-1 block text-xs font-medium text-muted-foreground">
							Disk cleanup
						</span>
						<div className="flex items-center justify-between gap-2">
							<p className="text-xs text-muted-foreground">
								{orphanCount === null
									? "Checking for orphaned worktrees…"
									: orphanCount === 0
										? "No orphaned worktrees found."
										: `${orphanCount} orphaned worktree${orphanCount === 1 ? "" : "s"} found on disk (no matching workspace).`}
							</p>
							<button
								type="button"
								disabled={busy || !orphanCount}
								onClick={onCleanupOrphans}
								className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
							>
								Clean up
							</button>
						</div>
					</div>

					<div className="mt-4 border-t border-border pt-3">
						<span className="mb-1 block text-xs font-medium text-muted-foreground">
							Agent daemon
						</span>
						<div className="flex items-center justify-between gap-2">
							<p className="text-xs text-muted-foreground">
								{liveSessionCount === null
									? "Checking…"
									: liveSessionCount === 0
										? "No agents running."
										: `${liveSessionCount} agent${liveSessionCount === 1 ? "" : "s"} running — survives closing this window.`}
							</p>
							<button
								type="button"
								disabled={busy || !liveSessionCount}
								onClick={onStopAllAgents}
								className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
							>
								Stop all agents
							</button>
						</div>
					</div>

					<div className="mt-4 border-t border-border pt-3">
						<span className="mb-1 block text-xs font-medium text-muted-foreground">
							Notifications
						</span>
						<div className="flex items-center justify-between gap-2">
							<p className="text-xs text-muted-foreground">
								{permissionState === "denied"
									? "Blocked by the browser — check this site's notification permission."
									: permissionState === "unsupported"
										? "Not supported in this browser."
										: notificationsOn
											? "On — you'll be notified when an agent needs input or finishes, in any project."
											: "Get notified when an agent needs input or finishes a turn, even in another project."}
							</p>
							<button
								type="button"
								disabled={busy || permissionState === "unsupported" || permissionState === "denied"}
								onClick={handleToggleNotifications}
								className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
							>
								{notificationsOn ? "Disable" : "Enable"}
							</button>
						</div>
					</div>

					{error && <p className="mt-2 text-xs text-destructive">{error}</p>}
					<div className="mt-4 flex justify-end gap-2">
						<button
							type="button"
							onClick={onClose}
							disabled={busy}
							className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={busy}
							className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
						>
							{busy ? "Saving…" : "Save"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
