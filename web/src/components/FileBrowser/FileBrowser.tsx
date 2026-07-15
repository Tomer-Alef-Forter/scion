import { ChevronRight, File as FileIcon, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { buildFileTree, type TreeNode } from "./buildFileTree";

interface FileBrowserProps {
	workspaceId: string;
	selectedPath: string | null;
	onSelectFile: (path: string) => void;
}

export function FileBrowser({ workspaceId, selectedPath, onSelectFile }: FileBrowserProps) {
	const [tree, setTree] = useState<TreeNode[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setTree(null);
		setError(null);
		api
			.getTree(workspaceId)
			.then((entries) => {
				if (!cancelled) setTree(buildFileTree(entries.map((e) => e.path)));
			})
			.catch((e) => {
				if (!cancelled) setError(String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId]);

	if (error) return <div className="p-3 text-sm text-destructive">{error}</div>;
	if (tree === null) {
		return <div className="p-3 text-sm text-muted-foreground">Loading files…</div>;
	}
	if (tree.length === 0) {
		return <div className="p-3 text-sm text-muted-foreground">No files.</div>;
	}

	return (
		<div className="h-full overflow-y-auto p-2 text-sm">
			{tree.map((node) => (
				<TreeItem
					key={node.path}
					node={node}
					depth={0}
					selectedPath={selectedPath}
					onSelectFile={onSelectFile}
				/>
			))}
		</div>
	);
}

function TreeItem({
	node,
	depth,
	selectedPath,
	onSelectFile,
}: {
	node: TreeNode;
	depth: number;
	selectedPath: string | null;
	onSelectFile: (path: string) => void;
}) {
	const [expanded, setExpanded] = useState(depth < 1);

	if (node.type === "file") {
		return (
			<button
				type="button"
				onClick={() => onSelectFile(node.path)}
				className={cn(
					"flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-accent",
					selectedPath === node.path && "bg-accent",
				)}
				style={{ paddingLeft: `${depth * 14 + 6}px` }}
			>
				<FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate">{node.name}</span>
			</button>
		);
	}

	return (
		<div>
			<button
				type="button"
				onClick={() => setExpanded((e) => !e)}
				className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left hover:bg-accent"
				style={{ paddingLeft: `${depth * 14 + 6}px` }}
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-muted-foreground transition-transform",
						expanded && "rotate-90",
					)}
				/>
				<Folder className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate">{node.name}</span>
			</button>
			{expanded &&
				node.children.map((child) => (
					<TreeItem
						key={child.path}
						node={child}
						depth={depth + 1}
						selectedPath={selectedPath}
						onSelectFile={onSelectFile}
					/>
				))}
		</div>
	);
}
