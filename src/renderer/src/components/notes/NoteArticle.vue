<script setup lang="ts">
// One note as a blog post: title, date and category, the Markdown body,
// then the notes that link here. [[links]] go to that note's page, #tags
// and the category to the index filtered by them. The outline sits beside
// the text on wide windows.
import { computed, nextTick, onMounted, watch } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import NoteMarkdown, { headingAnchor } from '@/components/notes/NoteMarkdown.vue';
import { confirmAction } from '@/lib/feedback.ts';
import * as model from '@/lib/notes_model.ts';
import { openWorkspaceFile } from '@/lib/open_file.ts';
import { useNotesStore } from '@/stores/notes.ts';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import * as markdown from '@shared/note_markdown.ts';

const emit = defineEmits<{ 'open-url': [url: string] }>();

const notes = useNotesStore();
const repositories = useRepositoriesStore();

const note = computed(() => notes.current!);
const draft = computed(() => notes.draft!);
const headings = computed(() => markdown.scanBody(draft.value.body).headings);
const incoming = computed(() => model.backlinks(notes.notes, note.value));
const exists = (title: string) => notes.findByTitle(title) !== null;
const canOpenSource = computed(() => Boolean(note.value.source?.file && note.value.source.repositoryId === repositories.currentId));
const run = (action: Promise<unknown>) => action.catch((error) => console.error('[notes] navigation failed', error));

const scrollToHeading = async (text: string | null) => {
  await nextTick();
  const heading = text ? headings.value.find((item) => markdown.titleKey(item.text) === markdown.titleKey(text)) : null;
  const target = heading ? document.getElementById(headingAnchor(heading.line)) : null;
  if (target) target.scrollIntoView({ block: 'start' });
  else document.querySelector('.main-content')?.scrollTo({ top: 0 });
};

// A new page starts at the top, or at the heading its link named.
const arrive = () => run(scrollToHeading(notes.route.name === 'note' ? notes.route.heading : null));
onMounted(arrive);
watch(() => notes.route, arrive);

const openLink = async (link: markdown.WikiLink) => {
  const target = notes.findByTitle(link.target);
  if (target) {
    await notes.goNote(target.id, link.heading);
    return;
  }
  if (markdown.titleProblem(link.target)) return;
  if (await confirmAction({ title: `新建「${link.target}」？`, body: '这篇笔记还不存在。', accept: '新建' }))
    await notes.create({ title: link.target, body: '', category: null, tags: [], source: null }, { open: true });
};

// A checkbox flips "[ ]" / "[x]" in the file at once, as Obsidian does.
const toggleTask = async (offset: number) => {
  const body = draft.value.body;
  const match = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(body.slice(offset));
  if (!match || note.value.frontmatterError) return;
  const at = offset + match[1].length;
  draft.value.body = `${body.slice(0, at)}${match[2] === ' ' ? 'x' : ' '}${body.slice(at + 1)}`;
  await notes.save();
};

const remove = async () => {
  const confirmed = await confirmAction({ title: '删除这篇笔记？', body: `「${note.value.title}」会移到系统废纸篓。`, accept: '删除', danger: true });
  if (confirmed) await notes.remove(note.value.id);
};
</script>

<template>
  <div class="article-layout" :data-note-open="note.id">
    <article class="blog-article">
      <header class="article-head">
        <h1>{{ note.title }}</h1>
        <div class="article-meta">
          <time>{{ model.formatDay(note.createdAt) }}</time>
          <span v-if="model.formatDay(note.updatedAt) !== model.formatDay(note.createdAt)">更新于 {{ model.formatDay(note.updatedAt) }}</span>
          <a v-if="note.category" class="post-category" role="link" tabindex="0" @click="run(notes.goIndex({ category: note.category }))">
            {{ model.CATEGORY_LABELS[note.category] }}
          </a>
          <a v-for="tag in model.allTags(note)" :key="tag" class="post-tag" role="link" tabindex="0" @click="run(notes.goIndex({ tag }))">#{{ tag }}</a>
        </div>
        <p v-if="model.sourceLabel(note.source)" class="article-source">
          来自
          <a v-if="canOpenSource" class="blog-link" role="link" tabindex="0" @click="openWorkspaceFile(note.source!.file!, note.source!.line)">
            {{ model.sourceLabel(note.source) }}
          </a>
          <span v-else>{{ model.sourceLabel(note.source) }}</span>
        </p>
        <div class="article-actions">
          <button class="secondary-button small" type="button" data-action="edit-note" :disabled="note.frontmatterError" @click="notes.startEditing()">
            <AppIcon name="wand" />
            编辑
          </button>
          <button class="icon-button small" type="button" aria-label="删除笔记" title="删除" data-action="delete-note" @click="remove">
            <AppIcon name="trash" />
          </button>
        </div>
      </header>

      <p v-if="note.frontmatterError" class="article-notice" role="alert">
        文件开头的属性（frontmatter）不是有效的 YAML，这里只能看不能改。请在其他编辑器里修好。
      </p>

      <aside v-if="note.summary" class="article-summary" aria-label="AI 总结">
        <strong>AI 总结</strong>
        <span v-if="note.summaryStale" class="tag warning" title="总结写好后正文又改过">可能过时</span>
        <p>{{ note.summary }}</p>
      </aside>

      <div class="article-body" data-note-preview>
        <NoteMarkdown
          v-if="draft.body.trim()"
          :body="draft.body"
          :exists="exists"
          @open-link="(link) => run(openLink(link))"
          @open-tag="(tag) => run(notes.goIndex({ tag }))"
          @open-url="(url) => emit('open-url', url)"
          @toggle-task="(offset) => run(toggleTask(offset))"
        />
        <p v-else class="blog-empty">
          这篇还没有内容。
          <button class="blog-link" type="button" @click="notes.startEditing()">开始写</button>
        </p>
      </div>

      <footer class="article-backlinks" data-backlinks>
        <h2>链接到这里的笔记</h2>
        <p v-if="!incoming.length" class="blog-muted">还没有。在别的笔记里写 [[{{ note.title }}]]，它就会出现在这里。</p>
        <ul v-else>
          <li v-for="other in incoming" :key="other.id">
            <a class="post-title" role="link" tabindex="0" @click="run(notes.goNote(other.id))" @keydown.enter="run(notes.goNote(other.id))">
              {{ other.title }}
            </a>
            <p v-if="other.summary || other.excerpt" class="post-excerpt">{{ other.summary ?? other.excerpt }}</p>
          </li>
        </ul>
      </footer>
    </article>

    <nav v-if="headings.length > 1" class="article-toc" aria-label="目录">
      <h4>目录</h4>
      <a
        v-for="heading in headings"
        :key="heading.line"
        class="toc-item"
        role="link"
        tabindex="0"
        :style="{ paddingLeft: `${(heading.depth - 1) * 12}px` }"
        @click="run(scrollToHeading(heading.text))"
      >
        {{ heading.text || '（空标题）' }}
      </a>
    </nav>
  </div>
</template>
