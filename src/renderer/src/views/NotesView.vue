<script setup lang="ts">
// 学习笔记, laid out like a personal blog: a quiet header, the archive of
// notes, and one page per note that [[links]] move between (with back and
// forward). Notes are a folder of Markdown files shared by every
// repository and readable by Obsidian; their text is never shown as markup.
import { onMounted, onUnmounted } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import NoteArticle from '@/components/notes/NoteArticle.vue';
import NoteEditor from '@/components/notes/NoteEditor.vue';
import NotesIndex from '@/components/notes/NotesIndex.vue';
import '@/components/notes/notes.css';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import { useNotesStore } from '@/stores/notes.ts';
import * as markdown from '@shared/note_markdown.ts';

const notes = useNotesStore();
const run = (action: Promise<unknown>) => action.catch((error) => console.error('[notes] action failed', error));

const startNew = () =>
  run(notes.create({ title: markdown.toTitle('未命名'), body: '', category: null, tags: [], source: null }, { autoRename: true, open: true }));

const openUrl = (url: string) => {
  notes.openUrl(url).catch((error) => {
    console.error('[notes] open url failed', error);
    showToast(`打不开链接：${describeError(error)}`, 'error');
  });
};

const chooseDirectory = async () => {
  try {
    if (await notes.chooseDirectory()) showToast('已切换笔记文件夹。原文件夹里的笔记没有移动。');
  } catch (error) {
    console.error('[notes] choose directory failed', error);
    showToast(`没能切换：${describeError(error)}`, 'error');
  }
};

const resetDirectory = () => run(notes.resetDirectory());
const reveal = () => run(notes.revealDirectory());

// Back and forward like a browser: ⌘[ / ⌘], or the mouse's side buttons.
const onKeydown = (event: KeyboardEvent) => {
  if (!(event.metaKey || event.ctrlKey) || notes.editing) return;
  if (event.key === '[') run(notes.goBack());
  else if (event.key === ']') run(notes.goForward());
};
const onMouseUp = (event: MouseEvent) => {
  if (notes.editing) return;
  if (event.button === 3) run(notes.goBack());
  else if (event.button === 4) run(notes.goForward());
};

onMounted(() => {
  notes.startWatching();
  run(notes.loadCourses());
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('mouseup', onMouseUp);
});
onUnmounted(() => {
  notes.stopWatching();
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('mouseup', onMouseUp);
});
</script>

<template>
  <div class="view notes-view notes-blog">
    <header class="blog-header">
      <h1>
        <a role="link" tabindex="0" data-action="notes-home" @click="run(notes.goIndex())">学习笔记</a>
      </h1>
      <nav class="blog-nav" aria-label="笔记导航">
        <button
          class="blog-nav-item"
          type="button"
          aria-label="后退"
          title="后退（⌘[）"
          :disabled="!notes.canGoBack"
          data-action="back"
          @click="run(notes.goBack())"
        >
          <AppIcon name="arrow-left" />
        </button>
        <button class="blog-nav-item" type="button" aria-label="前进" title="前进（⌘]）" :disabled="!notes.canGoForward" @click="run(notes.goForward())">
          <AppIcon name="arrow-right" />
        </button>
        <a class="blog-nav-item" :class="{ active: notes.route.name === 'index' }" role="link" tabindex="0" @click="run(notes.goIndex())">全部笔记</a>
        <el-dropdown trigger="click">
          <a class="blog-nav-item" role="button" tabindex="0" aria-label="笔记文件夹">
            <AppIcon name="folder" />
            文件夹
          </a>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled>{{ notes.directory }}</el-dropdown-item>
              <el-dropdown-item divided @click="reveal">在访达中显示</el-dropdown-item>
              <el-dropdown-item data-action="choose-folder" @click="chooseDirectory">换一个文件夹…</el-dropdown-item>
              <el-dropdown-item v-if="notes.custom" @click="resetDirectory">改回默认文件夹</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <a class="blog-nav-item primary" role="button" tabindex="0" data-action="new-note" @click="startNew" @keydown.enter="startNew">
          <AppIcon name="plus" />
          写笔记
        </a>
      </nav>
      <p v-if="notes.route.name === 'index'" class="blog-tagline">
        判卷时存下的点评和自己写的心得，所有项目共用。每篇是一个 Markdown 文件，也能用 Obsidian 打开同一个文件夹。
      </p>
    </header>

    <p v-if="notes.unavailable" class="notes-banner" role="alert">
      打不开上次选的文件夹 {{ notes.unavailable }}（可能被移走或删掉了），现在显示的是默认文件夹。
    </p>
    <p v-if="notes.truncated" class="notes-banner" role="alert">文件夹里的笔记超过 5000 篇，只显示最近修改的 5000 篇。</p>

    <NoteEditor v-if="notes.route.name === 'note' && notes.current && notes.draft && notes.editing" :key="`edit-${notes.current.id}`" />
    <NoteArticle v-else-if="notes.route.name === 'note' && notes.current && notes.draft" :key="notes.current.id" @open-url="openUrl" />
    <NotesIndex v-else-if="notes.route.name === 'index'" />
  </div>
</template>
