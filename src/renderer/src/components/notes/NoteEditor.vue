<script setup lang="ts">
// Editing the open note: title, properties, Markdown beside a live preview,
// and Tutor's summary. Typing [[ suggests titles. Saving never overwrites a
// file another program changed without asking; renaming asks whether to
// update [[links]] in other notes. Save or cancel returns to reading.
import { computed, nextTick, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import NoteMarkdown from '@/components/notes/NoteMarkdown.vue';
import { confirmAction, confirmChoice } from '@/lib/feedback.ts';
import * as model from '@/lib/notes_model.ts';
import { useNotesStore } from '@/stores/notes.ts';
import * as markdown from '@shared/note_markdown.ts';
import type * as ipc from '@shared/ipc_types.ts';

const notes = useNotesStore();

const CATEGORY_OPTIONS = (Object.keys(model.CATEGORY_LABELS) as ipc.GradeCategory[]).map((value) => ({ value, label: model.CATEGORY_LABELS[value] }));
const showPreview = ref(true);

const note = computed(() => notes.current!);
const draft = computed(() => notes.draft!);
const titleError = computed(() => markdown.titleProblem(draft.value.title));
const inlineTags = computed(() => markdown.scanBody(draft.value.body).tags);
// Links in the preview only show whether they resolve; following one waits for reading mode.
const exists = (title: string) => notes.findByTitle(title) !== null;

// ========== Saving ==========
// Resolves whether the note was saved.
const save = async () => {
  if (titleError.value) return false;
  let renameLinks = false;
  if (draft.value.title !== note.value.title) {
    const count = model.linkingCount(notes.notes, note.value.title, note.value.id);
    if (count) {
      const choice = await confirmChoice({
        title: '同时更新链接？',
        body: `有 ${count} 篇笔记链接到「${note.value.title}」。改名后要把它们的 [[${note.value.title}]] 改成 [[${draft.value.title}]] 吗？`,
        accept: '更新链接',
        alternate: '只改这篇',
      });
      if (choice === false) return false;
      renameLinks = choice === 'accept';
    }
  }
  return Boolean(await notes.save({ renameLinks }));
};

const saveAndRead = async () => {
  if (!notes.dirty || (await save())) notes.editing = false;
};

const overwrite = async () => {
  const confirmed = await confirmAction({ title: '覆盖磁盘上的版本？', body: '别处做的修改会被你的内容替换。', accept: '覆盖', danger: true });
  if (confirmed && (await notes.save({ force: true }))) notes.editing = false;
};

const onKeydown = (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
    event.preventDefault();
    save().catch((error) => console.error(error));
  }
};

// ========== [[ completion ==========
const textarea = ref<HTMLTextAreaElement | null>(null);
const completion = ref<{ start: number; query: string; index: number } | null>(null);
const suggestions = computed(() => (completion.value ? model.linkSuggestions(notes.notes, completion.value.query, note.value.id) : []));

const updateCompletion = () => {
  const element = textarea.value;
  if (!element) return;
  const found = model.linkQueryAt(element.value, element.selectionStart);
  completion.value = found ? { ...found, index: 0 } : null;
};

const pick = async (title: string) => {
  const element = textarea.value;
  const open = completion.value;
  if (!element || !open) return;
  const next = model.completeLink(element.value, open.start, element.selectionStart, title);
  draft.value.body = next.text;
  completion.value = null;
  await nextTick();
  element.focus();
  element.setSelectionRange(next.cursor, next.cursor);
};

const onEditorKeydown = (event: KeyboardEvent) => {
  const open = completion.value;
  if (!open || !suggestions.value.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    open.index = (open.index + step + suggestions.value.length) % suggestions.value.length;
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    pick(suggestions.value[open.index].title).catch((error) => console.error(error));
  } else if (event.key === 'Escape') {
    completion.value = null;
  }
};

const summaryText = computed({
  get: () => draft.value.summary ?? '',
  set: (value: string) => {
    draft.value.summary = value.trim() ? value : null;
  },
});
</script>

<template>
  <section class="note-editor" :data-note-open="note.id" data-note-editor @keydown="onKeydown">
    <header class="note-editor-head">
      <input v-model="draft.title" class="note-title-input" maxlength="80" aria-label="标题" placeholder="标题" />
      <label class="note-preview-toggle">
        <el-switch v-model="showPreview" />
        预览
      </label>
      <button class="secondary-button small" type="button" data-action="cancel-edit" @click="notes.stopEditing()">取消</button>
      <button class="primary-button small" type="button" data-action="save-note" :disabled="notes.saving || !!titleError" @click="saveAndRead">
        <AppIcon :name="notes.saving ? 'spinner' : 'check'" :class="{ spin: notes.saving }" />
        保存
      </button>
    </header>
    <p v-if="titleError && draft.title !== note.title" class="field-error">{{ titleError }}</p>

    <div v-if="notes.conflict" class="note-conflict" role="alert" data-note-conflict>
      <AppIcon name="alert" />
      <span>这篇笔记在别处被改过了（比如 Obsidian），你还有没保存的修改。</span>
      <button class="secondary-button small" type="button" data-action="discard-mine" @click="notes.discard()">放弃我的修改</button>
      <button class="secondary-button small danger" type="button" data-action="overwrite" @click="overwrite">用我的覆盖</button>
    </div>

    <div class="note-props">
      <el-select v-model="draft.category" class="note-prop-category" placeholder="不分类" clearable aria-label="分类">
        <el-option v-for="option in CATEGORY_OPTIONS" :key="option.value" :value="option.value" :label="option.label" />
      </el-select>
      <el-select
        v-model="draft.tags"
        class="note-prop-tags"
        multiple
        filterable
        allow-create
        default-first-option
        :reserve-keyword="false"
        :multiple-limit="8"
        placeholder="标签：选已有的或输入新的"
        aria-label="标签"
      >
        <el-option v-for="tag in notes.tags" :key="tag" :value="tag" :label="tag" />
      </el-select>
      <span v-for="tag in inlineTags" :key="tag" class="tag" title="正文里写的标签">#{{ tag }}</span>
    </div>

    <div class="note-body-area" :class="{ split: showPreview }">
      <div class="note-source-pane">
        <textarea
          ref="textarea"
          v-model="draft.body"
          class="note-textarea"
          aria-label="正文（Markdown）"
          placeholder="用 Markdown 写。输入 [[ 链接到其他笔记，#标签 直接写在正文里。"
          spellcheck="false"
          @input="updateCompletion"
          @click="updateCompletion"
          @keydown="onEditorKeydown"
          @blur="completion = null"
        />
        <ul v-if="completion && suggestions.length" class="link-suggestions glass-strong" role="listbox" aria-label="链接到笔记">
          <li
            v-for="(suggestion, index) in suggestions"
            :key="suggestion.id"
            role="option"
            :aria-selected="index === completion.index"
            :class="{ active: index === completion.index }"
            @mousedown.prevent="pick(suggestion.title)"
          >
            {{ suggestion.title }}
          </li>
        </ul>
      </div>
      <div v-if="showPreview" class="note-preview-pane blog-article" data-note-preview>
        <NoteMarkdown v-if="draft.body.trim()" :body="draft.body" :exists="exists" />
        <p v-else class="blog-muted">预览会显示在这里。</p>
      </div>
    </div>

    <section class="note-summary" aria-label="AI 总结">
      <h3>
        AI 总结
        <span v-if="note.summaryStale && !notes.dirty" class="tag warning" title="总结写好后正文又改过">可能过时</span>
      </h3>
      <p class="hint">导师判卷时只读标题和这段总结，不读正文。可以自己改。</p>
      <el-input
        v-model="summaryText"
        type="textarea"
        :rows="2"
        maxlength="300"
        show-word-limit
        placeholder="还没有总结，判卷时会用正文开头代替。"
        aria-label="AI 总结"
      />
      <button class="secondary-button small" type="button" data-action="summarize" :disabled="notes.summarizing" @click="notes.summarize()">
        <AppIcon :name="notes.summarizing ? 'spinner' : 'sparkle'" :class="{ spin: notes.summarizing }" />
        {{ note.summary ? '重新生成' : '生成总结' }}
      </button>
    </section>
  </section>
</template>
