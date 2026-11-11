<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import InlineCode from '@/components/InlineCode.vue';
import { useSetupStore } from '@/stores/setup.ts';
import { STEP_LABELS } from '@/lib/check_steps.ts';
import type { WorkPackageStatus } from '@shared/ipc/packages.ts';

const setup = useSetupStore();
const proposal = computed(() => setup.view?.plan?.configuration);
const work = computed(() => setup.view?.configurationPackage);
const active = computed(() => work.value && work.value.status !== 'done');
const STATUS: Record<WorkPackageStatus, string> = {
  pending: '待领取',
  in_progress: '执行中',
  in_review: '审查中',
  deviation: '偏差待处理',
  accepting: '待验收',
  blocked: '已阻塞',
  done: '已完成',
};
const run = (promise: Promise<unknown>) => promise.catch((error) => console.error(error));
</script>

<template>
  <section v-if="proposal || work" class="setup-configuration" aria-labelledby="configurationTitle">
    <h3 id="configurationTitle" class="settings-section-title">基础设施配置</h3>
    <div class="settings-card glass configuration-body">
      <template v-if="work">
        <div class="configuration-heading">
          <h4>{{ work.title }}</h4>
          <span class="status-pill" :class="work.status">{{ STATUS[work.status] }}</span>
        </div>
        <p v-if="work.installPending" class="configuration-note" role="status">配置改动已应用，先运行下面的「安装依赖」，再打开工作包继续检查和 QA 审查。</p>
        <p v-else-if="active" class="configuration-note">配置工作包已在队列里。打开后可以交给 Coding Agent，改动确认、QA 审查和保存到 git 都沿用工作包流程。</p>
        <p v-else class="configuration-note" role="status">
          {{
            work.needsCommit
              ? '配置已验收，先在执行页保存到 git，再回来重新分析，读取新增的检查脚本。'
              : '配置已完成并保存到 git。重新分析可读取新增脚本；项目检查配置会自动生效，本机自定义命令仍会保留。'
          }}
        </p>
        <div class="configuration-actions">
          <button class="secondary-button small" type="button" data-action="open-configuration" @click="run(setup.openConfiguration())">
            <AppIcon name="arrow-right" />
            {{ work.status === 'done' && work.needsCommit ? '去保存到 git' : '打开配置工作包' }}
          </button>
        </div>
      </template>

      <template v-if="proposal && !active && !(work?.status === 'done' && work.needsCommit)">
        <div v-if="!work" class="configuration-heading">
          <h4>{{ proposal.title }}</h4>
        </div>
        <p class="configuration-reason"><InlineCode :text="proposal.reason" /></p>
        <ul v-if="proposal.checks.length" class="configuration-checks" aria-label="计划补齐的检查">
          <li v-for="check in proposal.checks" :key="check.kind">
            <strong>{{ STEP_LABELS[check.kind] }}</strong>
            <code>{{ check.script }}</code>
            <span>{{ check.reason }}</span>
          </li>
        </ul>
        <details class="configuration-preview">
          <summary>查看实施步骤、文件范围和验收条件</summary>
          <h4>实施步骤</h4>
          <ol>
            <li v-for="(step, index) in proposal.steps" :key="index"><InlineCode :text="step" /></li>
          </ol>
          <h4>文件范围</h4>
          <ul class="configuration-files">
            <li v-for="file in proposal.fileScope" :key="file">
              <code>{{ file }}</code>
            </li>
          </ul>
          <h4>验收条件</h4>
          <ul>
            <li v-for="(criterion, index) in proposal.acceptance" :key="index"><InlineCode :text="criterion" /></li>
          </ul>
        </details>
        <p class="configuration-note">生成后加入工作队列，由 Coding Agent 实施。高风险配置需要你确认，完成后提交，再重新分析以识别新脚本。</p>
        <div class="configuration-actions">
          <button
            class="primary-button small"
            type="button"
            data-action="create-configuration"
            :disabled="setup.busy || setup.view?.stale || !setup.ready"
            @click="run(setup.createConfiguration())"
          >
            <AppIcon :name="setup.acting ? 'spinner' : 'plus'" :class="{ spin: setup.acting }" />
            {{ setup.acting ? '正在生成…' : '生成配置工作包' }}
          </button>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.configuration-body {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--panel-pad);
}
.configuration-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
.configuration-heading h4 {
  margin: 0;
  font-size: var(--text-md);
  color: var(--text);
}
.configuration-reason,
.configuration-note {
  margin: 0;
  max-width: 72ch;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.configuration-reason {
  color: var(--text);
  font-size: var(--text-sm);
}
.configuration-note {
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.configuration-checks,
.configuration-files {
  margin: 0;
  padding: 0;
  list-style: none;
}
.configuration-checks li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: var(--text-sm);
}
.configuration-checks span {
  color: var(--text-secondary);
}
.configuration-preview {
  min-width: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.configuration-preview summary {
  width: fit-content;
  padding-block: var(--space-1);
  color: var(--accent-strong);
  cursor: pointer;
}
.configuration-preview h4 {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--text-sm);
  color: var(--text);
}
.configuration-preview ol,
.configuration-preview ul:not(.configuration-files) {
  margin: 0;
  padding-left: var(--space-5);
  max-width: 75ch;
  line-height: 1.8;
}
.configuration-files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
}
.configuration-body code {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.configuration-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
@media (max-width: 640px) {
  .configuration-body {
    padding: var(--space-3);
  }
  .configuration-checks span {
    flex-basis: 100%;
  }
}
</style>
