<script setup lang="ts">
// "这一步怎么做？" under one step: the hint ladder. The first open asks for
// L1; each further level is opened on request, one at a time, and every
// level opened so far stays readable. Agent text is rendered with {{ }}
// only; the snippet is to read.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import { describeErrorInfo } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import { useTutorStore } from '@/stores/tutor.ts';

const props = defineProps<{ taskId: string; stepIndex: number }>();

// What each level gives, shown on its heading and on the button that opens it.
const LEVEL_NAMES: Record<number, string> = { 1: '讲清这一步', 2: '反问提示', 3: '思路步骤', 4: '对着失败的测试找问题', 5: '代码片段' };

const tutor = useTutorStore();
const state = computed(() => tutor.stateOf(props.taskId, props.stepIndex));
const open = ref(false);
const opened = computed(() => state.value?.opened ?? 0);
const maxLevel = computed(() => state.value?.maxLevel ?? 5);
const next = computed(() => (opened.value < maxLevel.value ? opened.value + 1 : null));
const busy = computed(() => state.value?.status === 'running');

const ask = (level: number) => tutor.ask(props.taskId, props.stepIndex, level);
const cancel = () => tutor.cancel(props.taskId, props.stepIndex);

// Opening shows the levels already opened; with none it asks for L1.
const toggle = async () => {
  open.value = !open.value;
  if (!open.value || opened.value > 0 || busy.value) return;
  await ask(1);
};

const copySnippet = async (code: string) => {
  try {
    await navigator.clipboard.writeText(code);
    showToast('已复制代码片段');
    await tutor.copied(props.taskId);
  } catch (error) {
    console.error('[tutor] clipboard failed', error);
    showToast('复制失败：系统剪贴板不可用', 'error');
  }
};

onMounted(() => tutor.refresh(props.taskId, props.stepIndex).catch((error) => console.error(error)));
onBeforeUnmount(() => tutor.stop(props.taskId, props.stepIndex));
</script>

<template>
  <div class="step-tutor" :data-tutor="stepIndex">
    <button class="link-button" type="button" :aria-expanded="open" @click="toggle">
      <AppIcon name="bot" />
      {{ opened ? (open ? '收起提示' : `查看提示（已用 L${opened}）`) : '这一步怎么做？' }}
    </button>
    <div v-if="open" class="tutor-card" role="region" :aria-label="`第 ${stepIndex + 1} 步的提示`">
      <p class="tutor-ladder" data-ladder>已用 L{{ opened }} / 共 {{ maxLevel }} 级</p>
      <section v-for="item in state?.levels ?? []" :key="item.level" class="tutor-level" :data-level="item.level">
        <h4>L{{ item.level }} · {{ LEVEL_NAMES[item.level] }}</h4>
        <p class="tutor-explanation"><InlineCode :text="item.answer.explanation" /></p>
        <ol v-if="item.answer.hints.length" class="tutor-hints">
          <li v-for="(hint, index) in item.answer.hints" :key="index"><InlineCode :text="hint" /></li>
        </ol>
        <div v-if="item.answer.snippet" class="tutor-snippet">
          <div class="tutor-snippet-head">
            <span>代码片段（{{ item.answer.snippet.language }}），读懂后按你的代码改写</span>
            <button class="secondary-button small" type="button" @click="copySnippet(item.answer.snippet.code)">
              <AppIcon name="copy" />
              复制
            </button>
          </div>
          <pre><code>{{ item.answer.snippet.code }}</code></pre>
        </div>
        <dl v-if="item.answer.terms.length" class="tutor-terms">
          <template v-for="term in item.answer.terms" :key="term.term">
            <dt>{{ term.term }}</dt>
            <dd>{{ term.meaning }}</dd>
          </template>
        </dl>
        <p v-if="item.source === 'lab'" class="tutor-note">导师这次没能回答，这是 lab 自带的提示。</p>
        <p v-else-if="item.filtered" class="tutor-note">有些代码离答案太近或超出这一级的篇幅，已经去掉。</p>
      </section>
      <p v-if="busy" class="tutor-status" role="status">
        <AppIcon name="spinner" class="spin" />
        导师正在准备 L{{ state?.pending }} 的提示…
        <button class="empty-action" type="button" @click="cancel">取消</button>
      </p>
      <p v-else-if="state?.status === 'failed'" class="tutor-status error">
        <AppIcon name="alert" />
        {{ describeErrorInfo(state.error) }}
        <button class="empty-action" type="button" @click="ask(state.pending ?? next ?? 1)">重试</button>
      </p>
      <div v-else-if="next && opened" class="tutor-next">
        <button class="secondary-button small" type="button" data-next-level @click="ask(next)">还是卡住？看 L{{ next }}：{{ LEVEL_NAMES[next] }}</button>
        <span v-if="next >= 3" class="tutor-note">练习模式下，从 L3 起会计入独立完成度，用到 L5 后参考答案解锁。</span>
      </div>
      <p v-else-if="opened >= maxLevel" class="tutor-note">5 级提示都已用过；练习模式下参考答案已解锁。</p>
      <p v-if="opened" class="tutor-note">由 AI 导师生成，可能有错。拿不准时运行测试验证。</p>
    </div>
  </div>
</template>
