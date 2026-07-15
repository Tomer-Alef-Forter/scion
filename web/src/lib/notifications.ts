// Desktop notifications for "this agent needs you" — opt-in (localStorage,
// mirroring web/src/lib/theme.ts's pattern exactly), gated on the browser's
// own Notification permission on top of that. Fires regardless of which
// project is currently selected — App.tsx tracks status by workspace id
// across ALL projects, not just the one on screen, since the whole point is
// noticing something in a project you're NOT currently looking at.
const STORAGE_KEY = "scion-notifications-enabled";

export function isNotificationsEnabled(): boolean {
	return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setNotificationsEnabled(enabled: boolean): void {
	localStorage.setItem(STORAGE_KEY, String(enabled));
}

export type NotificationPermissionState = NotificationPermission | "unsupported";

export function getPermissionState(): NotificationPermissionState {
	if (!("Notification" in window)) return "unsupported";
	return Notification.permission;
}

/** Requests OS permission — must be called from a user gesture (e.g. a Settings toggle click). */
export async function requestPermission(): Promise<boolean> {
	if (!("Notification" in window)) return false;
	if (Notification.permission === "granted") return true;
	if (Notification.permission === "denied") return false;
	const result = await Notification.requestPermission();
	return result === "granted";
}

interface AttentionWorkspace {
	id: string;
	name: string;
	status: "waiting" | "review";
}

/**
 * Fires an OS notification for a workspace that just started needing
 * attention. `tag: ws.id` means a repeat transition for the same workspace
 * REPLACES the previous notification instead of stacking a new one.
 * `onOpen` is called (in addition to focusing the window) when the user
 * clicks the notification — callers pass in whatever navigates to it.
 */
export function notifyAgentAttention(ws: AttentionWorkspace, onOpen: () => void): void {
	if (!isNotificationsEnabled()) return;
	if (!("Notification" in window) || Notification.permission !== "granted") return;
	// The user is already looking at the tab — the in-app indicators (status
	// pill, tab title badge) cover it; an OS notification would just be noise.
	if (document.hasFocus()) return;

	const title =
		ws.status === "waiting" ? `${ws.name} needs input` : `${ws.name} is ready to review`;
	const body =
		ws.status === "waiting"
			? "The agent is waiting for your input."
			: "The agent finished its turn.";

	const notification = new Notification(title, { body, tag: ws.id });
	notification.onclick = () => {
		window.focus();
		onOpen();
		notification.close();
	};
}
