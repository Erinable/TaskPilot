<script setup lang="ts">
// The tracked file tree. el-tree loads each directory's children only when it
// is expanded, so thousands of paths cost nothing until they are opened.
import { computed, ref } from 'vue';
import type { LoadFunction, TreeNodeData } from 'element-plus';

import AppIcon from '@/components/AppIcon.vue';
import { buildMapTree, summarizedOnly } from '@/lib/map_tree.ts';
import type { MapTreeNode } from '@/lib/map_tree.ts';

const props = defineProps<{ files: string[]; summarized: Set<string>; truncated: boolean }>();
const emit = defineEmits<{ select: [path: string] }>();

const onlySummarized = ref(false);

const fullTree = computed(() => buildMapTree(props.files, props.summarized));
const roots = computed(() => (onlySummarized.value ? summarizedOnly(fullTree.value) : fullTree.value));
// Lazy trees read their roots once, so a new root set remounts the tree.
const treeKey = computed(() => `${onlySummarized.value}:${props.files.length}:${props.summarized.size}:${fullTree.value.length}`);

const treeProps = { label: 'name', children: 'children', isLeaf: (data: TreeNodeData) => !(data as MapTreeNode).isDir };

const load: LoadFunction = (node, resolve) => resolve(node.level === 0 ? roots.value : (node.data as MapTreeNode).children);

const onNodeClick = (data: TreeNodeData) => {
  const node = data as MapTreeNode;
  if (!node.isDir) emit('select', node.path);
};
</script>

<template>
  <div class="map-tree">
    <div class="map-tree-toolbar">
      <span class="map-tree-total">{{ props.files.length }} 个文件 · 已摘要 {{ props.summarized.size }}</span>
      <el-switch v-model="onlySummarized" class="map-tree-filter" active-text="只看已摘要" aria-label="只看已摘要" />
    </div>
    <p v-if="props.truncated" class="map-tree-note" data-note="truncated">
      <AppIcon name="info" />
      仓库文件超过 5000 个，只显示前 5000 个
    </p>
    <p v-if="onlySummarized && roots.length === 0" class="empty-hint" data-empty="filtered">
      <AppIcon name="info" />
      没有已摘要的文件
    </p>
    <el-tree v-else :key="treeKey" class="map-tree-body" lazy :load="load" :props="treeProps" node-key="path" highlight-current @node-click="onNodeClick">
      <template #default="{ data }">
        <span class="map-node" :class="{ summarized: data.summarized }" :data-path="data.path">
          <AppIcon :name="data.isDir ? 'folder' : 'file'" />
          <span class="map-node-name">{{ data.name }}</span>
          <span v-if="data.isDir" class="map-node-count">已摘要 {{ data.summarizedCount }} / {{ data.fileCount }} 个文件</span>
          <span v-else-if="data.summarized" class="map-node-badge">已摘要</span>
        </span>
      </template>
    </el-tree>
  </div>
</template>

<style scoped>
.map-tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.map-tree-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 20px 10px;
}
.map-tree-total {
  color: var(--text-muted);
  font-size: 14px;
}
.map-tree-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 20px 10px;
  padding: 8px 10px;
  color: var(--warning);
  background: var(--warning-soft);
  border-radius: 8px;
  font-size: 14px;
}
.map-tree-note .icon {
  width: 15px;
  height: 15px;
}
.map-tree-body {
  flex: 1;
  min-height: 0;
  max-height: 640px;
  overflow: auto;
  padding: 0 12px 16px;
  background: transparent;
}
.map-node {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 14px;
  color: var(--text-secondary);
}
.map-node .icon {
  width: 15px;
  height: 15px;
  flex: 0 0 15px;
  color: var(--text-tertiary);
}
.map-node.summarized {
  color: var(--accent-strong);
  font-weight: 600;
}
.map-node.summarized .icon {
  color: var(--accent);
}
.map-node-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.map-node-count {
  margin-left: auto;
  padding-left: 12px;
  color: var(--text-tertiary);
  font-size: 14px;
  white-space: nowrap;
}
.map-node-badge {
  margin-left: 6px;
  padding: 0 6px;
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-radius: 5px;
  font-size: 14px;
  font-weight: 600;
}
</style>
