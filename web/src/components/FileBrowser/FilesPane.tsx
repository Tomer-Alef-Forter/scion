import { useState } from "react";
import { FileViewer } from "../FileViewer/FileViewer";
import { FileBrowser } from "./FileBrowser";

interface FilesPaneProps {
	workspaceId: string;
}

export function FilesPane({ workspaceId }: FilesPaneProps) {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);

	return (
		<div className="flex h-full">
			<div className="w-64 shrink-0 border-r border-border">
				<FileBrowser
					workspaceId={workspaceId}
					selectedPath={selectedPath}
					onSelectFile={setSelectedPath}
				/>
			</div>
			<div className="flex-1 overflow-hidden">
				{selectedPath ? (
					<FileViewer workspaceId={workspaceId} path={selectedPath} />
				) : (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						Select a file to view.
					</div>
				)}
			</div>
		</div>
	);
}
