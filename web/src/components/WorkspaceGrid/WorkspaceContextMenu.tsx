import { ExternalLink, GitMerge, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const MENU_WIDTH = 200;
const MENU_HEIGHT_MENU = 172;
const MENU_HEIGHT_RENAME = 92;
const VIEWPORT_MARGIN = 8;

interface WorkspaceContextMenuProps {
	x: number;
	y: number;
	workspaceName: string;
	busy: boolean;
	onClose: () => void;
	onRename: (name: string) => void;
	onMerge: () => void;
	onOpen: () => void;
	onDelete: () => void;
}

export function WorkspaceContextMenu({
	x,
	y,
	workspaceName,
	busy,
	onClose,
	onRename,
	onMerge,
	onOpen,
	onDelete,
}: WorkspaceContextMenuProps) {
	const [mode, setMode] = useState<"menu" | "rename">("menu");
	const [name, setName] = useState(workspaceName);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		function handlePointerDown(e: MouseEvent) {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		}
		function handleKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("mousedown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("mousedown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [onClose]);

	const menuHeight = mode === "menu" ? MENU_HEIGHT_MENU : MENU_HEIGHT_RENAME;
	const left = Math.min(x, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN);
	const top = Math.min(y, window.innerHeight - menuHeight - VIEWPORT_MARGIN);

	function submitRename(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		onRename(trimmed);
		onClose();
	}

	return (
		<div
			ref={ref}
			style={{ left, top, width: MENU_WIDTH }}
			className="fixed z-50 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
		>
			{mode === "menu" ? (
				<>
					<button
						type="button"
						onClick={() => setMode("rename")}
						className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
					>
						<Pencil className="size-3.5" /> Rename
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							onMerge();
							onClose();
						}}
						className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
					>
						<GitMerge className="size-3.5" /> Merge
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							onOpen();
							onClose();
						}}
						className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
					>
						<ExternalLink className="size-3.5" /> Open in editor
					</button>
					<div className="my-1 border-t border-border" />
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							onDelete();
							onClose();
						}}
						className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
					>
						<Trash2 className="size-3.5" /> Delete
					</button>
				</>
			) : (
				<form onSubmit={submitRename} className="p-1">
					<input
						autoFocus
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								onClose();
							}
						}}
						className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
					/>
					<div className="mt-1.5 flex justify-end gap-1.5">
						<button
							type="button"
							onClick={onClose}
							className="rounded-sm px-2 py-1 text-xs hover:bg-accent"
						>
							Cancel
						</button>
						<button
							type="submit"
							className="rounded-sm bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90"
						>
							Save
						</button>
					</div>
				</form>
			)}
		</div>
	);
}
