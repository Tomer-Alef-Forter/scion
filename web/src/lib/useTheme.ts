import { useEffect, useState } from "react";
import { getCurrentTheme, hasManualOverride, toggleTheme, type Theme } from "./theme";

/** Current theme + a toggle, kept in sync with system-preference changes
 * (only while the user hasn't manually overridden). */
export function useTheme(): [Theme, () => void] {
	const [theme, setThemeState] = useState<Theme>(getCurrentTheme);

	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => {
			if (!hasManualOverride()) setThemeState(getCurrentTheme());
		};
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	function toggle() {
		setThemeState(toggleTheme());
	}

	return [theme, toggle];
}
