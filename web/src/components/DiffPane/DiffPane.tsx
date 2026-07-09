// Diff viewer — adapted from Superset's LightDiffViewer:
// apps/desktop/src/renderer/screens/main/components/WorkspaceView/ChangesContent/components/LightDiffViewer/LightDiffViewer.tsx
// See NOTICE.md.
//
// IMPORTANT: @pierre/diffs' `PatchDiff` component is single-file only — its
// internal `getSingularPatch()` throws ("Provided patch must include only 1
// patch, with 1 diff") the moment the patch string covers more than one
// file. getUnifiedDiff() returns a whole-workspace `git diff` (commonly many
// files), so we parse the patch ourselves via `parsePatchFiles` and render
// one `FileDiff` per file instead — the correct multi-file composition this
// library expects. (Parsing itself is non-throwing by default; a malformed
// individual hunk is logged and skipped rather than aborting everything.)
//
// Theme uses @pierre/diffs' BUILT-IN names ("pierre-light"/"pierre-dark") —
// Superset's custom shiki-theme registration (pulling in their whole theme
// system) is intentionally dropped in favor of this simpler built-in option.
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useTheme } from "../../lib/useTheme";
import { CollapsibleFileDiff } from "./CollapsibleFileDiff";

interface DiffPaneProps {
	workspaceId: string;
}

export function DiffPane({ workspaceId }: DiffPaneProps) {
	const [files, setFiles] = useState<FileDiffMetadata[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [theme] = useTheme();

	useEffect(() => {
		let cancelled = false;
		setFiles(null);
		setError(null);
		api
			.getDiff(workspaceId)
			.then((patch) => {
				if (cancelled) return;
				if (!patch.trim()) {
					setFiles([]);
					return;
				}
				try {
					setFiles(parsePatchFiles(patch).flatMap((p) => p.files));
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			})
			.catch((e) => {
				if (!cancelled) setError(String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId]);

	if (error) {
		return <div className="p-4 text-sm text-destructive">{error}</div>;
	}
	if (files === null) {
		return <div className="p-4 text-sm text-muted-foreground">Loading diff…</div>;
	}
	if (files.length === 0) {
		return (
			<div className="p-4 text-sm text-muted-foreground">No changes vs base.</div>
		);
	}

	const diffOptions = {
		diffStyle: "unified" as const,
		theme: theme === "dark" ? ("pierre-dark" as const) : ("pierre-light" as const),
		themeType: theme,
		overflow: "wrap" as const,
	};

	return (
		<div className="h-full overflow-auto divide-y divide-border">
			{files.map((fileDiff, i) => (
				<CollapsibleFileDiff
					key={fileDiff.name || i}
					fileDiff={fileDiff}
					options={diffOptions}
				/>
			))}
		</div>
	);
}
