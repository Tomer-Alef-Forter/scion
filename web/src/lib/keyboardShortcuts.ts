// Shared guard for every global (document-level) keyboard shortcut listener.
// A shortcut must never fire while the user is typing into a real input, or
// while the terminal (a real xterm.js instance forwarding every keystroke to
// the agent process) has focus — otherwise e.g. Ctrl+K would steal bash's
// default "kill to end of line" readline binding right out of a live agent
// session.
export function isTypingTarget(e: KeyboardEvent): boolean {
	const el = e.target;
	if (!(el instanceof HTMLElement)) return false;
	if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) {
		return true;
	}
	// xterm.js wraps everything it renders in a root `.xterm` container —
	// true regardless of which specific inner node (helper textarea, viewport,
	// a row span) actually received the event.
	return el.closest(".xterm") !== null;
}

// App-global chords deliberately require a modifier (⌘ on macOS / Ctrl
// elsewhere) so they never collide with the terminal, which owns every
// UNMODIFIED keystroke and forwards it to the agent. These are the shortcuts
// allowed to "punch through" a focused xterm and act on the app instead — and
// they work identically whether the event arrives at document level or via
// xterm's custom key handler, so both paths call matchAppChord.
//
// Only ⌘K is bound here on purpose. Numeric chords (⌘1/⌘2/⌘3) look tempting
// for tab switching but browsers hard-reserve ⌘/Ctrl+number for switching
// browser tabs and won't let the page cancel them, so tab switching (and every
// other action) is reached through the command palette that ⌘K opens.
export type AppChord = { type: "command-palette" };

export function matchAppChord(e: KeyboardEvent): AppChord | null {
	const mod = e.metaKey || e.ctrlKey;
	// alt would turn these into OS/terminal chords we don't own.
	if (!mod || e.altKey) return null;
	if (e.key.toLowerCase() === "k") return { type: "command-palette" };
	return null;
}
