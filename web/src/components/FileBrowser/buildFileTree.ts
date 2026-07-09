export interface TreeNode {
	name: string;
	path: string;
	type: "file" | "dir";
	children: TreeNode[];
}

/** Builds a nested tree from a flat list of relative file paths. */
export function buildFileTree(paths: string[]): TreeNode[] {
	const root: TreeNode[] = [];

	for (const filePath of paths) {
		const segments = filePath.split("/");
		let level = root;
		let accumulated = "";
		for (let i = 0; i < segments.length; i++) {
			const name = segments[i]!;
			accumulated = accumulated ? `${accumulated}/${name}` : name;
			const isFile = i === segments.length - 1;
			let node = level.find((n) => n.name === name);
			if (!node) {
				node = { name, path: accumulated, type: isFile ? "file" : "dir", children: [] };
				level.push(node);
			}
			level = node.children;
		}
	}

	sortTree(root);
	return root;
}

function sortTree(nodes: TreeNode[]): void {
	nodes.sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	for (const node of nodes) sortTree(node.children);
}
