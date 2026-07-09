// Per-file collapse header wrapping @pierre/diffs' FileDiff. The library's
// `options.collapsed` is a controlled render flag with no built-in toggle UI
// (see DiffPane.tsx's header comment for why we don't use PatchDiff/its
// header mode) — so we render our own clickable header and keep FileDiff
// mounted throughout, just flipping `collapsed`. That avoids re-running
// syntax highlighting on every expand/collapse (which unmounting would cost).
import type { FileDiffMetadata, FileDiffOptions } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";

interface CollapsibleFileDiffProps {
	fileDiff: FileDiffMetadata;
	options: FileDiffOptions<undefined>;
}

function fileStats(fileDiff: FileDiffMetadata): { insertions: number; deletions: number } {
	let insertions = 0;
	let deletions = 0;
	for (const hunk of fileDiff.hunks) {
		insertions += hunk.additionLines;
		deletions += hunk.deletionLines;
	}
	return { insertions, deletions };
}

export function CollapsibleFileDiff({ fileDiff, options }: CollapsibleFileDiffProps) {
	const [expanded, setExpanded] = useState(true);
	const { insertions, deletions } = fileStats(fileDiff);

	return (
		<div>
			<button
				type="button"
				onClick={() => setExpanded((e) => !e)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
			>
				<ChevronRight
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform",
						expanded && "rotate-90",
					)}
				/>
				<span className="min-w-0 flex-1 truncate font-mono text-xs">
					{fileDiff.name}
					{fileDiff.prevName && fileDiff.prevName !== fileDiff.name && (
						<span className="text-muted-foreground"> ← {fileDiff.prevName}</span>
					)}
				</span>
				<span className="shrink-0 text-xs text-muted-foreground">
					{fileDiff.type === "new" && "added"}
					{fileDiff.type === "deleted" && "deleted"}
					{(fileDiff.type === "rename-pure" || fileDiff.type === "rename-changed") &&
						"renamed"}
				</span>
				{insertions > 0 && (
					<span className="shrink-0 text-xs text-green-600 dark:text-green-500">
						+{insertions}
					</span>
				)}
				{deletions > 0 && (
					<span className="shrink-0 text-xs text-red-600 dark:text-red-500">
						-{deletions}
					</span>
				)}
			</button>
			<FileDiff
				fileDiff={fileDiff}
				options={{ ...options, disableFileHeader: true, collapsed: !expanded }}
			/>
		</div>
	);
}
