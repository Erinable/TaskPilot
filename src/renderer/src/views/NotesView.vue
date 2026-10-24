<script setup lang="ts">
// 学习笔记: everything the developer chose to remember, from grading or
// written by hand, across every repository. Filter by category or tag,
// search, edit in place. Note text is the developer's and is shown with {{ }}.
import { computed, onMounted, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { confirmAction } from '@/lib/feedback.ts';
import { CATEGORY_LABELS, sourceLabel } from '@/lib/notes_model.ts';
import { openWorkspaceFile } from '@/lib/open_file.ts';
import { useNotesStore } from '@/stores/notes.ts';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import type * as ipc from '@shared/ipc_types.ts';

const notes = useNotesStore();
const repositories = useRepositoriesStore();

// The category choices; '' is "all" in the filter and "none" in the editor.
const CATEGORY_OPTIONS = [
  { value: '', label: '全部' },
  ...(Object.keys(CATEGORY_LABELS) as ipc.GradeCategory[]).map((value) => ({ value, label: CATEGORY_LABELS[value] })),
];

const categoryFilter = computed({
  get: () => notes.filter.category ?? '',
  set: (value: string) => {
    notes.filter.category = (value || null) as ipc.GradeCategory | null;
  },
});
const tagFilter = computed({
  get: () => notes.filter.tag ?? '',
  set: (value: string) => {
    notes.filter.tag = value || null;
  },
});

// ========== Editor ==========
type Draft = { id: string | null; title: string; body: string; category: string; tags: string[] };
const draft = ref<Draft | null>(null);
const saving = ref(false);

const startNew = () => {
  draft.value = { id: null, title: '', body: '', category: '', tags: [] };
};
const startEdit = (note: ipc.Note) => {
  draft.value = { id: note.id, title: note.title, body: note.body, category: note.category ?? '', tags: [...note.tags] };
};

const save = async () => {
  const current = draft.value;
  if (!current || saving.value) return;
  saving.value = true;
  const input = { title: current.title, body: current.body, category: (current.category || null) as ipc.GradeCategory | null, tags: current.tags };
  const saved = current.id ? await notes.update(current.id, input) : await notes.create({ ...input, source: null });
  saving.value = false;
  if (saved) draft.value = null;
};

const remove = async (note: ipc.Note) => {
  const confirmed = await confirmAction({ title: '删除这条笔记？', body: `「${note.title}」删除后不能恢复。`, accept: '删除', danger: true });
  if (confirmed) await notes.remove(note.id);
};

// A file link opens only in the repository the note came from.
const canOpen = (note: ipc.Note) => Boolean(note.source?.file && note.source.repositoryId === repositories.currentId);

onMounted(() => {
  if (!notes.loaded) notes.load().catch((error) => console.error('[notes] load failed', error));
});
</script>

<template>
  <div class="view notes-view">
    <div class="page-heading">
      <div>
        <h1>学习笔记</h1>
        <p>判卷时存下的点评和你自己写的心得，所有项目共用一份。导师判卷时会翻看，提醒你哪些问题又出现了。</p>
      </div>
      <div class="heading-actions">
        <button class="primary-button" type="button" data-action="new-note" :disabled="draft !== null" @click="startNew">
          <AppIcon name="plus" />
          写笔记
        </button>
      </div>
    </div>

    <div class="notes-filters">
      <el-input v-model="notes.filter.query" class="notes-search" placeholder="搜索标题、内容、标签或文件" clearable aria-label="搜索笔记" />
      <el-segmented v-model="categoryFilter" :options="CATEGORY_OPTIONS" aria-label="按分类筛选" />
      <el-select v-if="notes.tags.length" v-model="tagFilter" class="notes-tag-filter" placeholder="全部标签" clearable aria-label="按标签筛选">
        <el-option v-for="tag in notes.tags" :key="tag" :value="tag" :label="tag" />
      </el-select>
    </div>

    <form v-if="draft" class="panel glass note-editor" data-note-editor @submit.prevent="save">
      <label class="field-label" for="noteTitle">标题</label>
      <el-input id="noteTitle" v-model="draft.title" maxlength="80" show-word-limit placeholder="一句话说清要记住什么" />
      <label class="field-label" for="noteBody">内容</label>
      <el-input id="noteBody" v-model="draft.body" type="textarea" :rows="5" maxlength="4000" placeholder="为什么、怎么做，可以贴一小段代码" />
      <div class="note-editor-row">
        <div>
          <label class="field-label" for="noteCategory">分类</label>
          <el-select id="noteCategory" v-model="draft.category" class="w-full">
            <el-option value="" label="不分类" />
            <el-option v-for="option in CATEGORY_OPTIONS.slice(1)" :key="option.value" :value="option.value" :label="option.label" />
          </el-select>
        </div>
        <div>
          <label class="field-label" for="noteTags">标签</label>
          <el-select
            id="noteTags"
            v-model="draft.tags"
            class="w-full"
            multiple
            filterable
            allow-create
            default-first-option
            :reserve-keyword="false"
            placeholder="选已有的或输入新的"
          >
            <el-option v-for="tag in notes.tags" :key="tag" :value="tag" :label="tag" />
          </el-select>
        </div>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" @click="draft = null">取消</button>
        <button class="primary-button" type="submit" data-action="save-note" :disabled="saving || !draft.title.trim()">
          <AppIcon :name="saving ? 'spinner' : 'check'" :class="{ spin: saving }" />
          保存
        </button>
      </div>
    </form>

    <p v-if="notes.loaded && !notes.notes.length && !draft" class="empty-hint" data-notes-empty>
      还没有笔记。练习一个工作包，交卷后在导师的点评下点「存为笔记」，或者点右上角自己写一条。
    </p>
    <p v-else-if="notes.loaded && !notes.visible.length && !draft" class="empty-hint">没有符合筛选条件的笔记。</p>

    <div class="notes-list">
      <article v-for="note in notes.visible" :key="note.id" class="panel glass note-card" :data-note="note.id">
        <header class="note-head">
          <h2>{{ note.title }}</h2>
          <span v-if="note.category" class="tag note-category" :class="note.category">{{ CATEGORY_LABELS[note.category] }}</span>
          <div class="note-actions">
            <button class="icon-button small" type="button" :aria-label="`编辑 ${note.title}`" title="编辑" @click="startEdit(note)">
              <AppIcon name="wand" />
            </button>
            <button class="icon-button small" type="button" :aria-label="`删除 ${note.title}`" title="删除" data-action="delete-note" @click="remove(note)">
              <AppIcon name="trash" />
            </button>
          </div>
        </header>
        <p v-if="note.body" class="note-body">{{ note.body }}</p>
        <footer class="note-meta">
          <span v-for="tag in note.tags" :key="tag" class="tag">{{ tag }}</span>
          <button v-if="canOpen(note)" class="link-button note-source" type="button" @click="openWorkspaceFile(note.source!.file!, note.source!.line)">
            {{ sourceLabel(note.source) }}
          </button>
          <span v-else-if="sourceLabel(note.source)" class="note-source">{{ sourceLabel(note.source) }}</span>
        </footer>
      </article>
    </div>
  </div>
</template>

<style scoped>
.notes-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.notes-search {
  flex: 1 1 240px;
}
.notes-tag-filter {
  width: 160px;
}
.note-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.note-editor-row {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: var(--space-3);
}
.notes-list {
  display: grid;
  gap: var(--space-3);
}
.note-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.note-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.note-head h2 {
  margin: 0;
  font-size: var(--text-md);
}
.note-actions {
  margin-left: auto;
  display: flex;
  gap: var(--space-1);
}
.note-body {
  margin: 0;
  white-space: pre-wrap;
  color: var(--text-secondary);
}
.note-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.note-source {
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}
@media (max-width: 900px) {
  .note-editor-row {
    grid-template-columns: 1fr;
  }
}
</style>
