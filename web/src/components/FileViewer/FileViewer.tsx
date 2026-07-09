// Read-only, syntax-highlighted file viewer using @pierre/diffs' plain (non-
// diff) `File` renderer — same package/theme as DiffPane, for a consistent
// look. See NOTICE.md.
import { File } from "@pierre/diffs/react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useTheme } from "../../lib/useTheme";

interface FileViewerProps {
	workspaceId: string;
	path: string;
}

export function FileViewer({ workspaceId, path }: FileViewerProps) {
	const [contents, setContents] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [theme] = useTheme();

	useEffect(() => {
		let cancelled = false;
		setContents(null);
		setError(null);
		api
			.getFile(workspaceId, path)
			.then((text) => {
				if (!cancelled) setContents(text);
			})
			.catch((e) => {
				if (!cancelled) setError(String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, path]);

	if (error) return <div className="p-4 text-sm text-destructive">{error}</div>;
	if (contents === null) {
		return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
	}

	return (
		<div className="h-full overflow-auto">
			<File
				file={{ name: path, contents }}
				options={{
					theme: theme === "dark" ? "pierre-dark" : "pierre-light",
					themeType: theme,
					overflow: "wrap",
				}}
			/>
		</div>
	);
}
