// Pure tree building for the engineering map: tracked paths become nested
// directories, each counting its files and how many have a module summary.

export type MapTreeNode = {
  // Full path; a directory's path has no trailing slash.
  path: string;
  name: string;
  isDir: boolean;
  summarized: boolean;
  // For directories: files below it, and how many of them are summarized.
  fileCount: number;
  summarizedCount: number;
  children: MapTreeNode[];
};

const sortNodes = (nodes: MapTreeNode[]) => {
  nodes.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  for (const node of nodes) if (node.isDir) sortNodes(node.children);
};

// O(total path segments); directories come before files, both by name.
export const buildMapTree = (paths: string[], summarized: Set<string>): MapTreeNode[] => {
  const root: MapTreeNode[] = [];
  const directories = new Map<string, MapTreeNode>();
  for (const path of paths) {
    const segments = path.split('/');
    const isSummarized = summarized.has(path);
    let siblings = root;
    let prefix = '';
    for (const segment of segments.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let directory = directories.get(prefix);
      if (!directory) {
        directory = { path: prefix, name: segment, isDir: true, summarized: false, fileCount: 0, summarizedCount: 0, children: [] };
        directories.set(prefix, directory);
        siblings.push(directory);
      }
      directory.fileCount += 1;
      if (isSummarized) directory.summarizedCount += 1;
      siblings = directory.children;
    }
    siblings.push({ path, name: segments[segments.length - 1], isDir: false, summarized: isSummarized, fileCount: 0, summarizedCount: 0, children: [] });
  }
  sortNodes(root);
  return root;
};

// Keeps only summarized files and the directories that lead to them; counts
// still describe the whole directory.
export const summarizedOnly = (nodes: MapTreeNode[]): MapTreeNode[] => nodes
  .filter((node) => (node.isDir ? node.summarizedCount > 0 : node.summarized))
  .map((node) => (node.isDir ? { ...node, children: summarizedOnly(node.children) } : node));
