<script setup lang="ts">
// A course requirement's steps after the interview: pick the pack Tutor
// suggested (or another, or a new draft) and answer its questions; then
// adjust the learning path, or edit, save and confirm the drafted pack.
// Everything Tutor wrote is text, never markup.
//
// [人工决策-2026-10-27 00:55:52] 学生可以把节点标为"已会"或"跳过"、调整顺序；骨架本身不能改。
// 起草的课程包在编辑器里预览和编辑，保存后在本机确认才会用来规划路径。
// Once the path is confirmed, the first lab is generated after the learner
// saw what it covers and roughly what it costs, then self-checked; only its
// title, counts and each check's verdict are ever shown here, never its
// code, tests, hints or what a check found.
//
// [人工决策-2026-10-27 00:36:21] 自验证重试 2 次仍不过，lab 标为 needs_review，给出"换一个知识点"或"先用课程包示例"。
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { elapsedSince, useNow } from '@/lib/elapsed.ts';
import { describeErrorInfo } from '@/lib/errors.ts';
import { formatCost } from '@/lib/activity.ts';
import InlineCode from '@/components/InlineCode.vue';
import CourseContent from '@/components/courses/CourseContent.vue';
import CourseEditor from '@/components/courses/CourseEditor.vue';
import { useRepositoriesStore } from '@/stores/repositories.ts';
import { useRequirementsStore } from '@/stores/requirements.ts';
import AgentBubble from './AgentBubble.vue';
import * as model from './requirement_model.ts';
import { PATH_STATUSES, movedPath } from '@shared/course_plan.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';
import type { CoursePack } from '@shared/course_pack.ts';
import { TOOLCHAIN_LABELS } from '@shared/lab_toolchains.ts';
import type { PathStatus } from '@shared/course_plan.ts';

const props = defineProps<{ item: requirementTypes.Requirement; course: requirementTypes.CourseInterview }>();

const store = useRequirementsStore();
const repositories = useRepositoriesStore();

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

// ========== First lab ==========
const lab = computed(() => props.course.lab ?? null);
const estimate = computed(() => (store.labEstimate?.requirementId === props.item.id ? store.labEstimate.estimate : null));
const now = useNow();
const labElapsed = computed(() => (lab.value?.status === 'running' ? elapsedSince(lab.value.startedAt, now.value) : null));
const cancellingLab = ref(false);
const onCancelLab = () => {
  cancellingLab.value = true;
  report(store.cancelRun(props.item));
};
const onGenerate = () => {
  cancellingLab.value = false;
  report(store.generateLab(props.item));
};
// The stage the lab shown (or the next one, once it is written) is for.
const labStage = computed(() => {
  const current = lab.value;
  if (!current) return 1;
  return current.placed ? (current.stage ?? 1) + 1 : (current.stage ?? 1);
});
const labName = computed(() => (labStage.value === 1 ? '第一个 lab' : `第 ${labStage.value} 阶段 lab`));
const verify = computed(() => lab.value?.verify ?? null);
const lastRound = computed(() => verify.value?.rounds.at(-1) ?? null);
const otherConcepts = computed(() => model.otherPlannedConcepts(props.course));
const otherConcept = ref<string>('');
const onOtherConcept = () => {
  if (otherConcept.value) report(store.loadLabEstimate(props.item, otherConcept.value));
};
const VERIFY_CHECKS = Object.keys(model.VERIFY_CHECK_LABELS) as requirementTypes.LabVerifyCheck[];
// While running: the round, and while repairing what the round found.
const verifyProgress = computed(() => {
  const state = verify.value;
  if (!state) return null;
  const round = lastRound.value;
  const found = round && lab.value?.phase === 'repair' ? `：${VERIFY_CHECKS.map((check) => model.verifyCheckText(round, check)).join('，')}` : '';
  return `自验证第 ${state.round} / ${state.maxRounds} 轮${found}`;
});
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
      <section v-if="published" class="course-lab glass" data-section="first-lab" aria-live="polite">
        <template v-if="lab?.status === 'running'">
          <div class="agent-running">
            <AppIcon name="spinner" class="spin" />
            <span>{{ lab.phase ? model.LAB_PHASE_LABELS[lab.phase] : '正在生成 lab…' }}</span>
          </div>
          <small v-if="verifyProgress" data-field="verify-progress">{{ verifyProgress }}</small>
          <small>已用 {{ labElapsed ?? '0 秒' }}，花费 {{ formatCost(lab.costUsd) }}。生成加自验证通常要几分钟，可以先去做别的事。</small>
          <button class="secondary-button small" type="button" data-action="cancel-lab" :disabled="cancellingLab" @click="onCancelLab">
            <AppIcon name="x" />
            取消
          </button>
        </template>
        <template v-else-if="lab?.status === 'ready' && lab.lab && !(lab.placed && estimate)">
          <h3>
            <AppIcon name="flask" />
            {{ `${labName}：${lab.lab.title}` }}
          </h3>
          <p>{{ lab.lab.summary }}</p>
          <p class="course-path-note">
            {{
              `预计 ${lab.lab.estimateHours} 小时 · ${lab.lab.starterFiles} 个初始文件 · ${lab.lab.publicTests} 个公开测试 · ${lab.lab.hiddenTests} 个隐藏测试 · 花费 ${formatCost(lab.costUsd)}`
            }}
          </p>
          <p v-if="verify" class="course-path-note" data-field="verify-result">
            {{ `自验证第 ${verify.rounds.length} 轮通过（参考解、初始代码、变异检测、一致性），自验证花费 ${formatCost(verify.costUsd)}。` }}
          </p>
          <p v-if="lab.placed" class="course-path-note" data-field="lab-placed">已写入实验仓库，在工作队列的阶段条里打开它。</p>
          <div v-else class="req-actions">
            <button class="primary-button" type="button" data-action="place-lab" :disabled="store.courseBusy" @click="report(repositories.placeLab(item))">
              <AppIcon name="folder" />
              {{ course.repositoryId ? '加入实验仓库' : '选一个空文件夹，建实验仓库' }}
            </button>
          </div>
        </template>
        <template v-else-if="lab?.status === 'needs_review' && lab.lab && !estimate">
          <p class="course-warning" role="alert">
            <AppIcon name="alert" />
            <span>{{ `「${lab.lab.title}」自验证 ${verify?.rounds.length ?? 0} 轮都没通过，先不用它建实验仓库。` }}</span>
          </p>
          <ul v-if="lastRound" class="course-path-note" data-field="verify-result">
            <li v-for="check in VERIFY_CHECKS" :key="check">{{ model.verifyCheckText(lastRound, check) }}</li>
          </ul>
          <small>{{ `共花费 ${formatCost(lab.costUsd)}。` }}</small>
          <div class="req-actions">
            <el-select v-model="otherConcept" placeholder="换一个知识点" :disabled="!otherConcepts.length" aria-label="换一个知识点" data-field="other-concept">
              <el-option v-for="entry in otherConcepts" :key="entry.id" :label="entry.label" :value="entry.id" />
            </el-select>
            <button class="primary-button" type="button" data-action="other-concept" :disabled="!otherConcept || store.courseBusy" @click="onOtherConcept">
              <AppIcon name="flask" />
              换这个知识点
            </button>
            <button class="secondary-button" type="button" data-action="pack-example" disabled title="当前课程包还没有示例 lab">
              <AppIcon name="file" />
              先用课程包示例
            </button>
          </div>
          <small v-if="!otherConcepts.length">路径上没有别的「要学」知识点了。</small>
          <small>当前课程包还没有示例 lab，「先用课程包示例」暂时不能用。</small>
        </template>
        <template v-else>
          <p v-if="lab?.status === 'failed'" class="course-warning" role="alert">
            <AppIcon name="alert" />
            <span>{{ lab.error?.code === 'agent_cancelled' ? '已取消生成。' : `生成失败：${describeErrorInfo(lab.error)}` }}</span>
          </p>
          <template v-if="estimate">
            <h3>{{ `生成${labName}` }}</h3>
            <p>
              覆盖知识点：
              <code v-for="entry in estimate.concepts" :key="entry.id" class="path-chip">{{ entry.label }}</code>
              · 难度 {{ model.DIFFICULTY_LABELS[estimate.difficulty] }}
            </p>
            <p data-field="estimate">
              预计费用 {{ model.estimateText(estimate) }}，含生成后的自验证。自验证一次通过调用 {{ estimate.calls }} 次模型，要修改时最多
              {{ estimate.maxCalls }} 次。费用只做统计，以实际为准。
            </p>
            <div class="course-path-note" data-field="toolchain-check">
              <strong>工具链：{{ TOOLCHAIN_LABELS[estimate.toolchain.id] }}</strong>
              <span v-if="estimate.toolchain.problem === 'sandbox_unavailable'">自检需要 macOS sandbox，当前无法检查。</span>
              <ul>
                <li v-for="tool in estimate.toolchain.tools" :key="tool.command">
                  <code>{{ tool.command }}</code>
                  ：{{ tool.version ?? '未找到' }}
                  <template v-if="!tool.version">
                    ，安装命令：
                    <code>{{ tool.install }}</code>
                  </template>
                </li>
              </ul>
            </div>
            <div class="req-actions">
              <button
                class="primary-button"
                type="button"
                data-action="generate-lab"
                :disabled="store.courseBusy || !estimate.toolchain.ready"
                @click="onGenerate"
              >
                <AppIcon name="wand" />
                确认并生成
              </button>
              <button
                v-if="!estimate.toolchain.ready"
                class="secondary-button"
                type="button"
                data-action="recheck-toolchain"
                :disabled="store.courseBusy"
                @click="report(store.loadLabEstimate(item))"
              >
                重新检查
              </button>
            </div>
          </template>
          <div v-else class="req-actions">
            <button class="primary-button" type="button" data-action="estimate-lab" :disabled="store.courseBusy" @click="report(store.loadLabEstimate(item))">
              <AppIcon :name="store.courseBusy ? 'spinner' : 'flask'" :class="{ spin: store.courseBusy }" />
              {{ lab?.status === 'failed' ? `重新生成${labName}` : `生成${labName}` }}
            </button>
          </div>
        </template>
      </section>
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
.course-lab {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: 12px;
}
.course-lab h3,
.course-lab p {
  margin: 0;
}
.course-lab .course-warning {
  display: flex;
  gap: var(--space-2);
  color: var(--text-secondary);
}
.course-lab .course-warning .icon {
  flex: none;
  color: var(--warning);
}
</style>
