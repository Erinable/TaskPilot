<script setup lang="ts">
// The notes index, laid out like a blog's archive: notes grouped by month,
// newest first, each a title link with its date; one category or tag can
// be picked from the side. Note text is shown with {{ }} only.
import { computed, onUnmounted, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import * as model from '@/lib/notes_model.ts';
import { useNotesStore } from '@/stores/notes.ts';
import type * as packageTypes from '@shared/ipc/packages.ts';

const notes = useNotesStore();

const CATEGORIES = Object.keys(model.CATEGORY_LABELS) as packageTypes.GradeCategory[];
const groups = computed(() => model.groupByMonth(notes.visible));
const tagCounts = computed(() => model.tagCounts(notes.notes));
const categoryCounts = computed(() => model.categoryCounts(notes.notes));
const recent = computed(() => notes.notes.slice(0, 5));
const filtered = computed(() => Boolean(notes.filter.category || notes.filter.tag || notes.filter.query.trim()));

// Body search runs in the main process, a moment after typing stops.
let searchTimer: number | null = null;
watch(
  () => notes.filter.query,
  (query) => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => notes.search(query).catch((error) => console.error('[notes] search failed', error)), 250);
  },
);
onUnmounted(() => {
  if (searchTimer !== null) window.clearTimeout(searchTimer);
});

const run = (action: Promise<unknown>) => action.catch((error) => console.error('[notes] navigation failed', error));
</script>

<template>
  <div class="blog-index">
    <main class="blog-main">
      <div class="blog-search">
        <AppIcon name="search" />
        <input v-model="notes.filter.query" type="search" placeholder="搜索标题、正文、标签" aria-label="搜索笔记" />
      </div>

      <p v-if="notes.filter.category || notes.filter.tag" class="blog-filter-line">
        正在看
        <strong v-if="notes.filter.category">{{ model.CATEGORY_LABELS[notes.filter.category] }}</strong>
        <strong v-if="notes.filter.tag">#{{ notes.filter.tag }}</strong>
        ，共 {{ notes.visible.length }} 篇
        <button class="blog-link" type="button" @click="run(notes.goIndex())">看全部</button>
      </p>

      <p v-if="notes.loaded && !notes.notes.length" class="blog-empty" data-notes-empty>
        还没有笔记。练习一个工作包，交卷后在导师的点评下点「存为笔记」，或者点右上角「写笔记」自己写一篇。
      </p>
      <p v-else-if="notes.loaded && !notes.visible.length" class="blog-empty">没有符合条件的笔记。</p>

      <section v-for="group in groups" :key="group.month" class="post-group">
        <h3>{{ group.label }}</h3>
        <ul>
          <li v-for="note in group.notes" :key="note.id" class="post-item" :data-note="note.id">
            <div class="post-line">
              <a class="post-title" role="link" tabindex="0" @click="run(notes.goNote(note.id))" @keydown.enter="run(notes.goNote(note.id))">
                {{ note.title }}
              </a>
              <time>{{ model.formatDay(note.createdAt) }}</time>
            </div>
            <p v-if="note.summary || note.excerpt" class="post-excerpt">{{ note.summary ?? note.excerpt }}</p>
            <div v-if="note.category || model.allTags(note).length" class="post-meta">
              <a v-if="note.category" class="post-category" role="link" tabindex="0" @click="run(notes.goIndex({ category: note.category }))">
                {{ model.CATEGORY_LABELS[note.category] }}
              </a>
              <a v-for="tag in model.allTags(note)" :key="tag" class="post-tag" role="link" tabindex="0" @click="run(notes.goIndex({ tag }))">#{{ tag }}</a>
            </div>
          </li>
        </ul>
      </section>
    </main>

    <aside v-if="notes.notes.length && !filtered" class="blog-aside">
      <section>
        <h4>分类</h4>
        <ul>
          <li v-for="category in CATEGORIES" :key="category">
            <a class="blog-link" role="link" tabindex="0" @click="run(notes.goIndex({ category }))">{{ model.CATEGORY_LABELS[category] }}</a>
            <span class="count">{{ categoryCounts[category] ?? 0 }}</span>
          </li>
        </ul>
      </section>
      <section v-if="tagCounts.length">
        <h4>标签</h4>
        <div class="tag-cloud">
          <a v-for="entry in tagCounts" :key="entry.tag" class="post-tag" role="link" tabindex="0" @click="run(notes.goIndex({ tag: entry.tag }))">
            #{{ entry.tag }}
            <span class="count">{{ entry.count }}</span>
          </a>
        </div>
      </section>
      <section>
        <h4>最近更新</h4>
        <ul>
          <li v-for="note in recent" :key="note.id">
            <a class="blog-link" role="link" tabindex="0" @click="run(notes.goNote(note.id))">{{ note.title }}</a>
          </li>
        </ul>
      </section>
    </aside>
  </div>
</template>
