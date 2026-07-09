import type { WorkspaceWithStatus } from "../../lib/api";
import { WorkspaceCard } from "./WorkspaceCard";

interface WorkspaceGridProps {
	workspaces: WorkspaceWithStatus[];
	selectedWorkspaceId: string | null;
	onSelect: (workspace: WorkspaceWithStatus) => void;
	onNew: () => void;
}

export function WorkspaceGrid({
	workspaces,
	selectedWorkspaceId,
	onSelect,
	onNew,
}: WorkspaceGridProps) {
	return (
		<div className="flex h-full w-80 shrink-0 flex-col border-r border-border">
			<div className="flex items-center justify-between border-b border-border px-3 py-2.5">
				<h2 className="text-sm font-medium">Workspaces</h2>
				<button
					type="button"
					onClick={onNew}
					className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90"
				>
					+ New
				</button>
			</div>
			<div className="flex-1 overflow-y-auto p-2">
				<ul className="space-y-0.5">
					{workspaces.map((ws) => (
						<li key={ws.id}>
							<WorkspaceCard
								workspace={ws}
								selected={ws.id === selectedWorkspaceId}
								onClick={() => onSelect(ws)}
							/>
						</li>
					))}
					{workspaces.length === 0 && (
						<li className="px-3 py-2 text-sm text-muted-foreground">
							No workspaces yet — click "+ New" to create one.
						</li>
					)}
				</ul>
			</div>
		</div>
	);
}
