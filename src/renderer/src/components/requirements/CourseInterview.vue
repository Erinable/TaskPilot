<script setup lang="ts">
// A course requirement's steps after the interview: pick the pack Tutor
// suggested (or another, or a new draft) and answer its questions; then
// adjust the learning path, or edit, save and confirm the drafted pack.
// Everything Tutor wrote is text, never markup.
//
// [人工决策-2026-10-27 00:55:52] 学生可以把节点标为"已会"或"跳过"、调整顺序；骨架本身不能改。
// 起草的课程包在编辑器里预览和编辑，保存后在本机确认才会用来规划路径。
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import CourseContent from '@/components/courses/CourseContent.vue';
import CourseEditor from '@/components/courses/CourseEditor.vue';
import { useRequirementsStore } from '@/stores/requirements.ts';
import AgentBubble from './AgentBubble.vue';
import * as model from './requirement_model.ts';
import { PATH_STATUSES, movedPath } from '@shared/course_plan.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';
import type { CoursePack } from '@shared/course_pack.ts';
import type { PathStatus } from '@shared/course_plan.ts';

const props = defineProps<{ item: requirementTypes.Requirement; course: requirementTypes.CourseInterview }>();

const store = useRequirementsStore();

const report = (promise: Promise<unknown>) => {
  promise.catch((error) => console.error(error));
};

// ========== Choosing a pack ==========
const DRAFT = '__draft__';
const options = computed(() => props.course.pick?.options ?? []);
const initialChoice = () => {
  const choice = props.course.choice;
  if (choice) return 'draft' in choice ? DRAFT : choice.course;
  return props.course.pick?.course ?? DRAFT;
};
const chosen = ref(initialChoice());
const answers = ref(props.item.questions.map((question) => question.answer ?? ''));
const choiceOf = (): requirementTypes.CourseChoice => (chosen.value === DRAFT ? { draft: true } : { course: chosen.value });
const onPlan = () => report(store.runStep(props.item, 'plan', [...answers.value], choiceOf()));

// ========== Path ==========
const plan = computed(() => props.course.plan);
const extras = computed(() => plan.value?.extraConcepts ?? []);
const concept = (conceptId: string) => model.pathConcept(props.course, conceptId);
const counts = computed(() => {
  const path = plan.value?.path ?? [];
  return Object.fromEntries(PATH_STATUSES.map((status) => [status, path.filter((entry) => entry.status === status).length])) as Record<PathStatus, number>;
});
const canMove = (index: number, offset: number) =>
  plan.value ? movedPath(plan.value.path, index, offset, props.course.pathConcepts, extras.value) !== null : false;
const move = (index: number, offset: number) => {
  if (!plan.value) return;
  const next = movedPath(plan.value.path, index, offset, props.course.pathConcepts, extras.value);
  if (next) report(store.savePath(props.item, next));
};
const mark = (index: number, status: PathStatus) => {
  if (!plan.value || plan.value.path[index].status === status) return;
  report(
    store.savePath(
      props.item,
      plan.value.path.map((entry, at) => (at === index ? { ...entry, status } : entry)),
    ),
  );
};
const published = computed(() => props.item.status === 'published');

// ========== Draft ==========
const draft = computed(() => props.course.draft);
const editing = ref(false);
// The pack saved from the draft and waiting for this machine's confirmation.
const saved = computed(() => (store.draftSaved?.requirementId === props.item.id ? store.draftSaved : null));
const savedChoice = computed(() => {
  const choice = props.course.choice;
  return choice && 'course' in choice && !draft.value && !plan.value ? choice.course : null;
});
const onSaveDraft = (pack: CoursePack) => store.saveDraft(props.item, pack);
</script>

<template>
  <div class="course-interview">
    <template v-if="item.status === 'answering' || item.status === 'draft'">
      <AgentBubble v-if="item.summary" agent="tutor" :text="`我理解的目标：${item.summary}`" />
      <AgentBubble v-if="course.pick" agent="tutor" :text="course.pick.reason" />
      <fieldset class="question-card glass course-choice" data-field="choice">
        <legend class="question-text">用哪个课程包规划路径</legend>
        <el-radio-group v-model="chosen" class="course-choice-options" aria-label="课程包">
          <el-radio v-for="option in options" :key="option.id" :value="option.id" :data-course="option.id">
            {{ option.title }}
            <small>{{ option.id }}</small>
            <span v-if="course.pick?.course === option.id" class="scope-badge in-use">Tutor 推荐</span>
          </el-radio>
          <el-radio :value="DRAFT" data-course="draft">
            新建课程包
            <small>Tutor 按你的目标起草一个，你预览、编辑并确认后才会用</small>
            <span v-if="course.pick && course.pick.course === null" class="scope-badge in-use">Tutor 推荐</span>
          </el-radio>
        </el-radio-group>
      </fieldset>
      <AgentBubble v-if="item.questions.length" agent="tutor" :text="`规划之前想再确认 ${item.questions.length} 件事，拿不准可以留空，我会用常见的做法。`" />
      <form class="req-questions" novalidate @submit.prevent="onPlan">
        <div v-for="(question, index) in item.questions" :key="index" class="question-card glass">
          <label class="question-text" :for="`courseAnswer${index}`">
            <span class="question-index">{{ index + 1 }}</span>
            <span><InlineCode :text="question.text" /></span>
          </label>
          <el-input
            :id="`courseAnswer${index}`"
            v-model="answers[index]"
            type="textarea"
            :rows="2"
            :maxlength="model.MAX_ANSWER"
            placeholder="你的回答（可留空）"
            :data-index="index"
          />
        </div>
        <div class="req-actions">
          <button class="primary-button" type="submit" data-action="course-plan" :disabled="store.acting !== null" :aria-busy="store.acting === 'plan'">
            <AppIcon :name="store.acting === 'plan' ? 'spinner' : chosen === DRAFT ? 'wand' : 'list-checks'" :class="{ spin: store.acting === 'plan' }" />
            {{ chosen === DRAFT ? '起草课程包' : '规划学习路径' }}
          </button>
        </div>
      </form>
    </template>

    <template v-else-if="plan && (item.status === 'reviewing' || published)">
      <AgentBubble v-if="published" agent="tutor" text="学习路径已确认。之后的 lab 会按这条路径出题。" icon-name="check-circle" />
      <AgentBubble agent="tutor" :text="plan.summary" />
      <div class="plan-summary">
        <span>
          <AppIcon name="blocks" />
          {{ plan.course.id }} · {{ plan.course.version }}
        </span>
        <span>
          <AppIcon name="list-checks" />
          {{ `要学 ${counts.planned} 个，已会 ${counts.known} 个，跳过 ${counts.skipped} 个` }}
        </span>
      </div>
      <ol class="course-path" aria-label="学习路径">
        <li
          v-for="(entry, index) in plan.path"
          :key="entry.conceptId"
          class="course-path-item glass"
          :data-concept="entry.conceptId"
          :data-status="entry.status"
        >
          <div class="course-path-head">
            <span class="question-index">{{ index + 1 }}</span>
            <strong>{{ concept(entry.conceptId).label }}</strong>
            <code class="path-chip">{{ entry.conceptId }}</code>
            <span v-if="entry.conceptId.startsWith('ai:')" class="scope-badge selected">临时节点</span>
          </div>
          <p v-if="concept(entry.conceptId).summary">{{ concept(entry.conceptId).summary }}</p>
          <div v-if="!published" class="course-path-actions">
            <el-radio-group
              :model-value="entry.status"
              size="small"
              :aria-label="`${concept(entry.conceptId).label}的状态`"
              :disabled="store.courseBusy"
              @change="(status: string | number | boolean | undefined) => mark(index, status as PathStatus)"
            >
              <el-radio-button v-for="status in PATH_STATUSES" :key="status" :value="status">{{ model.PATH_STATUS_LABELS[status] }}</el-radio-button>
            </el-radio-group>
            <button
              class="icon-button small"
              type="button"
              :aria-label="`上移${concept(entry.conceptId).label}`"
              :disabled="store.courseBusy || !canMove(index, -1)"
              @click="move(index, -1)"
            >
              <AppIcon name="arrow-left" class="quarter-turn" />
            </button>
            <button
              class="icon-button small"
              type="button"
              :aria-label="`下移${concept(entry.conceptId).label}`"
              :disabled="store.courseBusy || !canMove(index, 1)"
              @click="move(index, 1)"
            >
              <AppIcon name="arrow-right" class="quarter-turn" />
            </button>
          </div>
          <small v-else class="course-path-status">{{ model.PATH_STATUS_LABELS[entry.status] }}</small>
        </li>
      </ol>
      <p v-if="!published" class="course-path-note">只能调整顺序和标记；前置知识点必须排在前面。知识点本身来自课程包，想改要去「课程」里复制一份再改。</p>
      <div v-if="!published" class="req-actions sticky">
        <button class="secondary-button" type="button" :disabled="store.acting !== null || store.courseBusy" @click="report(store.editAnswers(item))">
          <AppIcon name="arrow-left" />
          重新选择
        </button>
        <button class="primary-button" type="button" data-action="confirm-path" :disabled="store.courseBusy" @click="report(store.confirmPath(item))">
          <AppIcon name="check" />
          确认路径
        </button>
      </div>
    </template>

    <template v-else-if="draft && item.status === 'reviewing'">
      <AgentBubble agent="tutor" text="现有的课程包都覆盖不到你的目标，我起草了一个。下面每一项都会作为指令交给 AI 团队，请读完、按需修改，再保存并确认。" />
      <section class="course-draft glass" :data-draft="draft.pack.id">
        <div class="panel-heading">
          <div>
            <h3>{{ draft.pack.title }}</h3>
            <p>{{ draft.pack.id }} · 版本 {{ draft.pack.version }} · 草稿</p>
          </div>
          <button v-if="!editing" class="secondary-button small" type="button" data-action="edit-draft" @click="editing = true">
            <AppIcon name="sliders" />
            编辑并保存
          </button>
        </div>
        <CourseEditor v-if="editing" :pack="draft.pack" :save="onSaveDraft" @close="editing = false" />
        <CourseContent v-else :pack="draft.pack" :changes="[]" />
      </section>
      <div v-if="!editing" class="req-actions sticky">
        <button class="secondary-button" type="button" :disabled="store.acting !== null" @click="report(store.editAnswers(item))">
          <AppIcon name="arrow-left" />
          重新选择
        </button>
        <button class="secondary-button" type="button" :disabled="store.acting !== null" @click="report(store.runStep(item, 'plan'))">
          <AppIcon name="refresh" />
          重新起草
        </button>
      </div>
    </template>

    <template v-else-if="savedChoice && item.status === 'reviewing'">
      <AgentBubble agent="tutor" :text="`课程包「${savedChoice}」已保存到全局目录。确认后就用它规划你的学习路径。`" />
      <section v-if="saved" class="course-draft glass" :data-saved="saved.pack.id">
        <p class="course-warning" role="note">
          <AppIcon name="alert" />
          <span>下面每一项都会作为指令交给 Product Lead 和导师。请读完全部内容再确认；内容以后有变化，要重新确认。</span>
        </p>
        <CourseContent :pack="saved.pack" :changes="[]" />
      </section>
      <div class="req-actions sticky">
        <button
          v-if="saved"
          class="primary-button"
          type="button"
          data-action="confirm-draft"
          :disabled="store.courseBusy || store.acting !== null"
          @click="report(store.confirmDraft(item))"
        >
          <AppIcon name="check" />
          确认并规划路径
        </button>
        <template v-else>
          <p class="course-path-note">到「课程」里查看并确认这个课程包，再回来规划路径。</p>
          <button class="primary-button" type="button" data-action="course-plan" :disabled="store.acting !== null" @click="report(store.runStep(item, 'plan'))">
            <AppIcon name="list-checks" />
            规划学习路径
          </button>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.course-interview {
  display: grid;
  gap: var(--space-3);
}
.course-choice {
  margin: 0;
  border: 0;
}
.course-choice-options {
  display: grid;
  gap: var(--space-2);
  align-items: start;
}
.course-choice-options small {
  margin-left: var(--space-2);
  color: var(--text-muted);
}
.course-path {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.course-path-item {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: 12px;
}
.course-path-item[data-status='known'],
.course-path-item[data-status='skipped'] {
  opacity: 0.72;
}
.course-path-item p {
  margin: 0;
  color: var(--text-secondary);
}
.course-path-head,
.course-path-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.course-path-note,
.course-path-status {
  color: var(--text-muted);
}
.course-draft {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: 12px;
}
.course-draft h3 {
  margin: 0;
}
</style>
