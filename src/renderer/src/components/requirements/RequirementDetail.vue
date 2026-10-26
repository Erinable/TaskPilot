<script setup lang="ts">
// An existing requirement: status, stepper, and the conversation for its
// current step. Keyed on the store's detail revision, so local state (answers,
// disabled buttons) resets whenever the page re-renders it.
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import { useRequirementsStore } from '@/stores/requirements.ts';
import { describeErrorInfo } from '@/lib/errors.ts';
import { elapsedSince, useNow } from '@/lib/elapsed.ts';
import AgentBubble from './AgentBubble.vue';
import InterfacesPanel from './InterfacesPanel.vue';
import PlanPackageCard from './PlanPackageCard.vue';
import MilestonePicker from './MilestonePicker.vue';
import CourseInterview from './CourseInterview.vue';
import * as model from './requirement_model.ts';
import type * as requirementTypes from '@shared/ipc/requirements.ts';

const props = defineProps<{ item: requirementTypes.Requirement }>();

const store = useRequirementsStore();

const answers = ref(props.item.questions.map((question) => question.answer ?? ''));
// Questions handed back to Product Lead: a blank answer tells it to pick a
// sensible default and say so in the plan (see product_lead.planPrompt).
const defaults = ref(props.item.questions.map(() => false));
const useDefault = (index: number) => {
  answers.value[index] = '';
  defaults.value[index] = true;
};
const cancelling = ref(false);
const publishing = ref(false);

const running = computed(() => model.isRunning(props.item));
const now = useNow();
// The step that runs started at the requirement's last update.
const elapsed = computed(() => (running.value ? elapsedSince(props.item.updatedAt, now.value) : null));
const architectRunning = computed(() => running.value && props.item.phase === 'architect');
const course = computed(() => (model.isCourse(props.item) ? (props.item.course ?? null) : null));
const steps = computed(() => (course.value ? model.COURSE_STEPS : model.STEPS));
const drafting = computed(() => Boolean(course.value?.choice && 'draft' in course.value.choice));
const runningLabel = computed(() => {
  if (course.value) return props.item.status === 'planning' ? (drafting.value ? '正在起草课程包…' : '正在规划学习路径…') : '正在看你的目标，挑选课程包…';
  return props.item.status === 'planning'
    ? '正在拆解工作包…'
    : props.item.phase === 'architect'
      ? 'Architect 正在阅读相关代码…'
      : '正在阅读需求，准备澄清问题…';
});
const bubbleAgent = computed(() => (props.item.phase === 'architect' ? 'arch' : course.value ? 'tutor' : 'pm'));
const failedStep = computed(() => (props.item.failedStep === 'planning' ? 'plan' : 'clarify'));

const plan = computed(() => props.item.plan);
const planTotal = computed(() => Math.round((plan.value?.packages ?? []).reduce((sum, pkg) => sum + pkg.estimateHours, 0) * 10) / 10);
const planFiles = computed(() => new Set((plan.value?.packages ?? []).flatMap((pkg) => pkg.fileScope)).size);

const report = (promise: Promise<unknown>) => {
  promise.catch((error) => console.error(error));
};

const onCancel = () => {
  cancelling.value = true;
  report(store.cancelRun(props.item));
};

const onPublish = async () => {
  publishing.value = true;
  if (!(await store.publishPlan(props.item))) publishing.value = false;
};

const onSubmitAnswers = () => report(store.runStep(props.item, 'plan', [...answers.value]));
</script>

<template>
  <div class="req-pane" data-pane="detail">
    <header class="req-header">
      <div class="req-title-row">
        <span class="status-pill" :class="model.STATUS_TONES[item.status]">{{ model.STATUS_LABELS[item.status] }}</span>
        <h2>{{ item.title || (course ? '未命名的学习目标' : '未命名需求') }}</h2>
        <span v-if="course" class="scope-badge selected">我想学</span>
      </div>
      <ol class="req-stepper" aria-label="进度">
        <li v-for="entry in steps" :key="entry.step" :data-step="entry.step" :class="model.stepClasses(item, entry.step)">
          <span class="step-dot"></span>
          {{ entry.label }}
        </li>
      </ol>
    </header>

    <details class="req-original glass">
      <summary>
        <AppIcon name="file" />
        {{ course ? '学习目标' : '原始需求' }}
      </summary>
      <p>{{ item.text }}</p>
    </details>

    <div class="req-body">
      <!-- The summary sits above the conversation once it exists. -->
      <InterfacesPanel v-if="item.interfaces && !architectRunning" :info="item.interfaces" />

      <template v-if="running">
        <AgentBubble tone="running" :agent="bubbleAgent">
          <div class="agent-running">
            <AppIcon name="spinner" class="spin" />
            <span>{{ runningLabel }}</span>
          </div>
          <small>已用 {{ elapsed ?? '0 秒' }}，通常 20 秒到 1 分钟。可以先去做别的事，完成后会通知你。</small>
          <button class="secondary-button small" type="button" :disabled="cancelling" @click="onCancel">
            <AppIcon name="x" />
            取消
          </button>
        </AgentBubble>
      </template>

      <template v-else-if="item.status === 'failed'">
        <AgentBubble :text="describeErrorInfo(item.error)" tone="failed" icon-name="alert" :agent="bubbleAgent">
          <code v-if="item.error?.message && item.error.code !== 'agent_cancelled'" class="agent-error-detail">{{ item.error.message }}</code>
        </AgentBubble>
        <div class="req-actions">
          <button
            class="primary-button"
            type="button"
            :disabled="store.acting !== null"
            :aria-busy="store.acting === failedStep"
            @click="report(store.runStep(item, failedStep))"
          >
            <AppIcon :name="store.acting === failedStep ? 'spinner' : 'refresh'" :class="{ spin: store.acting === failedStep }" />
            {{ failedStep === 'plan' ? (course ? '重试' : '重新拆解') : course ? '重新访谈' : '重新澄清' }}
          </button>
          <button
            v-if="failedStep === 'plan'"
            class="secondary-button"
            type="button"
            :disabled="store.acting !== null"
            :aria-busy="store.acting === 'edit'"
            @click="report(store.editAnswers(item))"
          >
            <AppIcon :name="store.acting === 'edit' ? 'spinner' : 'arrow-left'" :class="{ spin: store.acting === 'edit' }" />
            {{ course ? '重新选择' : '修改回答' }}
          </button>
        </div>
      </template>

      <CourseInterview v-else-if="course" :item="item" :course="course" />

      <template v-else-if="item.status === 'answering' || item.status === 'draft'">
        <AgentBubble v-if="item.summary" :text="`我理解的需求：${item.summary}`" />
        <AgentBubble v-if="item.questions.length === 0" text="需求已经足够清楚，没有需要澄清的问题。可以直接拆解。" />
        <AgentBubble
          v-else
          :text="`开始拆解前，我有 ${item.questions.length} 个问题。看不懂或拿不准的，点「不确定，用推荐做法」，我会选一个简单稳妥的做法并在计划里写明。`"
        />
        <form class="req-questions" novalidate @submit.prevent="onSubmitAnswers">
          <div v-for="(question, index) in item.questions" :key="index" class="question-card glass">
            <label class="question-text" :for="`reqAnswer${index}`">
              <span class="question-index">{{ index + 1 }}</span>
              <span><InlineCode :text="question.text" /></span>
            </label>
            <el-input
              :id="`reqAnswer${index}`"
              v-model="answers[index]"
              type="textarea"
              :rows="2"
              :maxlength="model.MAX_ANSWER"
              :placeholder="defaults[index] ? '将使用推荐做法' : '你的回答（可留空）'"
              :data-index="index"
              @input="defaults[index] = false"
            />
            <button
              class="link-button"
              type="button"
              :aria-pressed="defaults[index]"
              :class="{ chosen: defaults[index] }"
              :data-default="index"
              @click="useDefault(index)"
            >
              <AppIcon :name="defaults[index] ? 'check' : 'sparkle'" />
              {{ defaults[index] ? '将使用推荐做法' : '不确定，用推荐做法' }}
            </button>
          </div>
          <div class="req-actions">
            <button class="primary-button" type="submit" :disabled="store.acting !== null" :aria-busy="store.acting === 'plan'">
              <AppIcon :name="store.acting === 'plan' ? 'spinner' : 'blocks'" :class="{ spin: store.acting === 'plan' }" />
              开始拆解
            </button>
          </div>
        </form>
      </template>

      <template v-else-if="plan && (item.status === 'reviewing' || item.status === 'published')">
        <AgentBubble v-if="item.status === 'published'" :text="`已发布 ${item.packages.length} 个工作包到工作队列。`" icon-name="check-circle" />
        <AgentBubble :text="plan.summary" />
        <div class="plan-summary">
          <span>
            <AppIcon name="blocks" />
            {{ `${plan.packages.length} 个工作包` }}
          </span>
          <span>
            <AppIcon name="clock" />
            {{ `合计约 ${planTotal} 小时` }}
          </span>
          <span>
            <AppIcon name="file" />
            {{ `${planFiles} 个文件` }}
          </span>
          <span v-if="item.costUsd > 0" class="plan-cost">
            <AppIcon name="info" />
            {{ `本需求累计费用 $${item.costUsd.toFixed(3)}` }}
          </span>
        </div>
        <PlanPackageCard v-for="(pkg, index) in plan.packages" :key="index" :pkg="pkg" :index="index" />
        <MilestonePicker v-if="item.status === 'published'" :requirement-id="item.id" />
        <div class="req-actions sticky">
          <button v-if="item.status === 'published'" class="primary-button" type="button" @click="report(store.showQueue())">
            <AppIcon name="arrow-right" />
            查看工作队列
          </button>
          <template v-else>
            <button
              class="secondary-button"
              type="button"
              :disabled="store.acting !== null || publishing"
              :aria-busy="store.acting === 'edit'"
              @click="report(store.editAnswers(item))"
            >
              <AppIcon :name="store.acting === 'edit' ? 'spinner' : 'arrow-left'" :class="{ spin: store.acting === 'edit' }" />
              修改回答
            </button>
            <button
              class="secondary-button"
              type="button"
              :disabled="store.acting !== null || publishing"
              :aria-busy="store.acting === 'plan'"
              @click="report(store.runStep(item, 'plan'))"
            >
              <AppIcon :name="store.acting === 'plan' ? 'spinner' : 'refresh'" :class="{ spin: store.acting === 'plan' }" />
              重新拆解
            </button>
            <button class="primary-button" type="button" :disabled="publishing || store.acting !== null" :aria-busy="publishing" @click="report(onPublish())">
              <AppIcon :name="publishing ? 'spinner' : 'send'" :class="{ spin: publishing }" />
              {{ `发布 ${plan.packages.length} 个工作包` }}
            </button>
          </template>
        </div>
      </template>

      <div v-if="!running && item.status !== 'published'" class="req-delete">
        <button class="link-button danger" type="button" @click="report(store.removeRequirement(item))">
          <AppIcon name="trash" />
          删除这个需求
        </button>
      </div>
    </div>
  </div>
</template>
