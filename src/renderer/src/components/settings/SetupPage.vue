<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import { KIND_LABEL, resultText, useSetupStore } from '@/stores/setup.ts';
import type * as ipc from '@shared/ipc_types.ts';

const setup = useSetupStore();

const run = (promise: Promise<unknown>) => { promise.catch((error) => console.error(error)); };
const onAllowScripts = (value: string | number | boolean) => run(setup.setAllowScripts(value === true));
const stepState = (step: ipc.EnvStep) => {
  if (setup.view?.running === step.id) return { text: '运行中', tone: 'in_progress' };
  if (step.result) return { text: resultText(step.result), tone: step.result.ok ? 'done' : 'blocked' };
  return { text: '未运行', tone: '' };
};
</script>

<template>
  <header class="settings-page-header">
    <h2>环境初始化</h2>
    <span class="scope-badge"><AppIcon name="bot" />环境管家</span>
  </header>
  <p class="settings-page-intro">环境管家读取仓库里已提交的 package.json、lockfile、版本文件和 CI 配置，给出安装与验证步骤。每一步都要你点击确认后才由 TaskPilot 运行，命令只会从 npm 的固定选项和 package.json 脚本名中拼出。</p>
  <div class="setup-toolbar">
    <p id="setupStatus" class="setup-status" :class="{ 'warn-text': setup.statusWarn }" aria-live="polite">{{ setup.statusText }}</p>
    <div class="setup-actions">
      <button v-if="setup.showCancel" id="setupCancel" class="secondary-button small" type="button" @click="run(setup.cancel())"><AppIcon name="x" />取消</button>
      <button id="setupPlan" class="primary-button" type="button" :disabled="setup.busy" @click="run(setup.plan())"><AppIcon name="sparkle" />{{ setup.planLabel }}</button>
    </div>
  </div>
  <div v-if="setup.ready && setup.view" id="setupBody">
    <h3 class="settings-section-title">仓库事实</h3>
    <div class="settings-card glass">
      <dl id="setupFacts" class="fact-list">
        <template v-for="fact in setup.facts" :key="fact.term"><dt>{{ fact.term }}</dt><dd>{{ fact.value }}</dd></template>
      </dl>
    </div>
    <div id="setupNotices">
      <template v-if="setup.notices.length">
        <h3 class="settings-section-title">提示</h3>
        <div class="settings-card glass setup-notice-list">
          <div v-for="(notice, index) in setup.notices" :key="index" class="setup-notice" :class="notice.tone">
            <AppIcon :name="notice.icon" />
            <div>
              <p>{{ notice.text }}</p>
              <template v-if="notice.detail"><small>建议（TaskPilot 不会自动运行）：</small><code class="setup-fix">{{ notice.detail }}</code></template>
            </div>
          </div>
        </div>
      </template>
    </div>
    <h3 class="settings-section-title">步骤</h3>
    <div class="settings-card glass">
      <div class="setting-row">
        <label class="setting-label" for="setupAllowScripts"><strong>允许依赖的安装脚本</strong><small>默认带 --ignore-scripts 安装，依赖包的 preinstall/postinstall 不会运行。原生模块（如 node-gyp 编译）可能因此失败。</small></label>
        <div class="setting-control end">
          <el-switch id="setupAllowScripts" :model-value="setup.view.allowScripts" :disabled="setup.busy || setup.view.stale" @update:model-value="onAllowScripts" />
        </div>
      </div>
      <ol id="setupSteps" class="setup-steps">
        <li v-for="step in setup.view.steps" :key="step.id" class="setup-step">
          <div class="setup-step-head">
            <div class="setup-step-label"><strong>{{ KIND_LABEL[step.kind] ?? step.kind }}</strong><code>{{ step.line }}</code></div>
            <span class="status-pill" :class="stepState(step).tone">{{ stepState(step).text }}</span>
            <button class="secondary-button small" type="button" :data-step="step.id" :disabled="setup.busy || setup.view.stale" @click="run(setup.runStep(step.id))">
              <AppIcon name="play" />{{ step.result ? '再次运行' : '运行' }}
            </button>
          </div>
          <details v-if="step.result?.output" class="setup-output" :open="!step.result.ok">
            <summary>输出（最后部分）</summary>
            <pre class="verify-output">{{ step.result.output }}</pre>
          </details>
        </li>
        <li v-if="!setup.view.steps.length" class="setup-step empty">没有可运行的步骤。</li>
      </ol>
    </div>
    <div v-if="setup.failedStep" id="setupRetry" class="setup-retry">
      <p id="setupRetryText">{{ setup.retryText }}</p>
      <button id="setupReplan" class="secondary-button small" type="button" :disabled="setup.busy || setup.view.stale" @click="run(setup.replan())"><AppIcon name="bot" />让环境管家分析失败</button>
    </div>
    <h3 class="settings-section-title">写入验证命令</h3>
    <div class="settings-card glass">
      <el-checkbox-group v-model="setup.selectedKinds" tag="ul" id="setupApply" class="setup-apply">
        <li v-for="item in setup.applyItems" :key="item.kind" class="setup-apply-item">
          <el-checkbox :value="item.kind" :disabled="item.disabled">
            <span><strong>{{ KIND_LABEL[item.kind] }}</strong><code>{{ item.proposed }}</code><small>{{ item.note }}</small></span>
          </el-checkbox>
        </li>
        <li v-if="!setup.applyItems.length" class="setup-apply-item empty">计划里没有可写入的验证命令。</li>
      </el-checkbox-group>
      <div class="setup-apply-footer">
        <button id="setupApplyButton" class="secondary-button small" type="button" :disabled="setup.busy || setup.view.stale || !setup.applyItems.length" @click="run(setup.apply())">
          <AppIcon name="check" />写入所选命令
        </button>
      </div>
    </div>
  </div>
</template>
