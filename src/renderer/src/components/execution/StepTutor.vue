<script setup lang="ts">
// "这一步怎么做？" under one step: asks Tutor once, then shows the saved
// answer. Agent text is rendered with {{ }} only; the snippet is to read.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import { describeErrorInfo } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import { useTutorStore } from '@/stores/tutor.ts';

const props = defineProps<{ taskId: string; stepIndex: number }>();

const tutor = useTutorStore();
const state = computed(() => tutor.stateOf(props.taskId, props.stepIndex));
const open = ref(false);

const ask = () => tutor.ask(props.taskId, props.stepIndex);
const cancel = () => tutor.cancel(props.taskId, props.stepIndex);

// Opening shows a saved answer straight away; otherwise it asks.
const toggle = async () => {
  open.value = !open.value;
  if (!open.value || state.value?.status === 'done' || state.value?.status === 'running') return;
  await ask();
};

const copySnippet = async (code: string) => {
  try {
    await navigator.clipboard.writeText(code);
    showToast('已复制参考代码');
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
      {{ state?.status === 'done' ? (open ? '收起讲解' : '查看讲解') : '这一步怎么做？' }}
    </button>
    <div v-if="open" class="tutor-card" role="region" :aria-label="`第 ${stepIndex + 1} 步的讲解`">
      <p v-if="state?.status === 'running'" class="tutor-status" role="status">
        <AppIcon name="spinner" class="spin" />
        导师正在读相关代码，准备讲解…
        <button class="empty-action" type="button" @click="cancel">取消</button>
      </p>
      <p v-else-if="state?.status === 'failed'" class="tutor-status error">
        <AppIcon name="alert" />
        {{ describeErrorInfo(state.error) }}
        <button class="empty-action" type="button" @click="ask">重试</button>
      </p>
      <template v-else-if="state?.status === 'done' && state.answer">
        <p class="tutor-explanation"><InlineCode :text="state.answer.explanation" /></p>
        <ol v-if="state.answer.hints.length" class="tutor-hints">
          <li v-for="(hint, index) in state.answer.hints" :key="index"><InlineCode :text="hint" /></li>
        </ol>
        <div v-if="state.answer.snippet" class="tutor-snippet">
          <div class="tutor-snippet-head">
            <span>参考写法（{{ state.answer.snippet.language }}），读懂后按你的代码改写</span>
            <button class="secondary-button small" type="button" @click="copySnippet(state.answer.snippet.code)">
              <AppIcon name="copy" />
              复制
            </button>
          </div>
          <pre><code>{{ state.answer.snippet.code }}</code></pre>
        </div>
        <dl v-if="state.answer.terms.length" class="tutor-terms">
          <template v-for="term in state.answer.terms" :key="term.term">
            <dt>{{ term.term }}</dt>
            <dd>{{ term.meaning }}</dd>
          </template>
        </dl>
        <p class="tutor-note">由 AI 导师生成，可能有错。拿不准时运行测试验证。</p>
      </template>
    </div>
  </div>
</template>
