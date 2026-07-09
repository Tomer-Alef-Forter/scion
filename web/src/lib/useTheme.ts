import { useState } from "react";
import { getCurrentTheme, toggleTheme, type Theme } from "./theme";

/** Current theme + a toggle. Defaults to dark; a manual toggle persists. */
export function useTheme(): [Theme, () => void] {
	const [theme, setThemeState] = useState<Theme>(getCurrentTheme);

	function toggle() {
		setThemeState(toggleTheme());
	}

	return [theme, toggle];
}
