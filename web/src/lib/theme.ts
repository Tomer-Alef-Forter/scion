// Dark mode: defaults to the OS preference, overridable via a manual toggle
// that persists in localStorage. Once the user overrides, system-preference
// changes stop being followed (an explicit choice always wins).
const STORAGE_KEY = "scion-theme";
export type Theme = "light" | "dark";

function getStoredTheme(): Theme | null {
	const stored = localStorage.getItem(STORAGE_KEY);
	return stored === "light" || stored === "dark" ? stored : null;
}

function getSystemTheme(): Theme {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function applyTheme(theme: Theme): void {
	document.documentElement.classList.toggle("dark", theme === "dark");
}

export function getCurrentTheme(): Theme {
	return getStoredTheme() ?? getSystemTheme();
}

/** Call once, synchronously, before the first render — avoids a flash of the wrong theme. */
export function initTheme(): void {
	applyTheme(getCurrentTheme());
}

export function setTheme(theme: Theme): void {
	localStorage.setItem(STORAGE_KEY, theme);
	applyTheme(theme);
}

export function toggleTheme(): Theme {
	const next: Theme = getCurrentTheme() === "dark" ? "light" : "dark";
	setTheme(next);
	return next;
}

export function hasManualOverride(): boolean {
	return getStoredTheme() !== null;
}
