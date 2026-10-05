/* Environment setup page: the Environment Steward proposes, the user confirms
   each step, and the main process runs commands it rebuilds itself. This file
   only ever sends step ids and script kinds. */
(() => {
  const api = window.taskpilot.env;
  const page = $('#setupPage');
  const POLL_MS = 800;

  const BLOCKER_TEXT = {
    no_manifest: '仓库里没有已提交的 package.json，目前只支持 Node/npm 项目。',
    invalid_manifest: 'package.json 不是合法的 JSON。',
    unsupported_manager: '仓库使用了 npm 以外的包管理器（yarn/pnpm/bun），安装步骤已禁用，脚本仍可运行。',
    node_missing: '在当前 PATH 中找不到 node。可以在「运行环境」里改为从登录 shell 读取 PATH。',
    npm_missing: '在当前 PATH 中找不到 npm。',
  };
  const ADJUSTMENT_TEXT = {
    install_without_manifest: '没有 package.json，已跳过安装。',
    ci_without_lockfile: '仓库没有 package-lock.json，已把 npm ci 改为 npm install。',
    unknown_script: (a) => `package.json 里没有脚本「${a.script}」，已取消 ${a.kind} 步骤。`,
  };
  const KIND_LABEL = { install: '安装依赖', test: '测试', lint: 'Lint', build: 'Build' };

  let view = null;
  let pollTimer = null;
  let acting = false; // a click is waiting on the main process

  const visible = () => !page.hidden && !$('#settingsView').hidden;

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    const waiting = view && (view.status === 'planning' || view.running);
    if (waiting && visible()) pollTimer = setTimeout(() => render(), POLL_MS);
  }

  async function render() {
    try {
      view = await call(api.get());
    } catch (error) {
      $('#setupStatus').textContent = `读取失败：${describeError(error)}`;
      return;
    }
    paint();
    schedulePoll();
  }

  /** Runs an action, repaints from its returned view, and keeps polling if needed. */
  async function act(promise, { failure } = {}) {
    acting = true;
    paint();
    // Long steps hold the call open; poll meanwhile so "运行中" and Cancel show.
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => render(), 200);
    try {
      view = await call(promise);
      return true;
    } catch (error) {
      if (error.code !== 'agent_cancelled') showToast(`${failure ?? '操作失败'}：${describeError(error)}`, 'error');
      return false;
    } finally {
      acting = false;
      await render();
    }
  }

  function statusText() {
    if (!view || view.status === 'idle') return '还没有分析过这个仓库。';
    if (view.status === 'planning') return '环境管家正在读取仓库并制定步骤…';
    if (view.status === 'failed') return `分析失败：${describeError(view.error)}`;
    const parts = [];
    if (view.stale) parts.push('工作区已切换，这份计划已过期，请重新分析。');
    else if (view.plan) parts.push(view.plan.summary);
    else parts.push('无法制定步骤。');
    if (view.costUsd > 0) parts.push(`（本次分析 $${view.costUsd.toFixed(3)}）`);
    return parts.join(' ');
  }

  function paint() {
    const busy = acting || view?.status === 'planning' || Boolean(view?.running);
    const status = $('#setupStatus');
    status.textContent = statusText();
    status.className = `setup-status${view?.status === 'failed' || view?.stale ? ' warn-text' : ''}`;
    $('#setupPlan').disabled = busy;
    $('#setupPlan').lastChild.textContent = view && view.status !== 'idle' ? '重新分析' : '分析环境';
    $('#setupCancel').hidden = !(view?.status === 'planning' || view?.running);

    const ready = view?.status === 'ready';
    $('#setupBody').hidden = !ready;
    if (!ready) return;
    paintFacts();
    paintNotices();
    paintSteps(busy);
    paintApply(busy);
  }

  function paintFacts() {
    const facts = view.facts;
    const list = $('#setupFacts');
    const add = (term, value) => list.append(el('dt', null, term), el('dd', null, value || '—'));
    list.replaceChildren();
    add('项目', facts.manifest?.name ?? (facts.manifest ? '（未命名）' : null));
    add('脚本', facts.manifest ? Object.keys(facts.manifest.scripts).join('  ') : null);
    add('Lockfile', facts.lockfiles.join('  '));
    add('node_modules', facts.nodeModules ? '已存在' : '不存在');
    add('版本要求', [
      facts.manifest?.engines?.node && `engines.node ${facts.manifest.engines.node}`,
      ...facts.versionFiles.map((file) => `${file.path} ${file.content}`),
    ].filter(Boolean).join('  '));
    add('本机 node / npm', `${facts.tools.node ?? '未找到'} / ${facts.tools.npm ?? '未找到'}`);
    add('CI 配置', facts.workflows.join('  '));
  }

  function notice(tone, iconName, text, detail) {
    const item = el('div', `setup-notice ${tone}`);
    const body = el('div');
    body.append(el('p', null, text));
    if (detail) {
      const fix = el('code', 'setup-fix', detail);
      body.append(el('small', null, '建议（TaskPilot 不会自动运行）：'), fix);
    }
    item.append(icon(iconName), body);
    return item;
  }

  function paintNotices() {
    const box = $('#setupNotices');
    const items = [];
    for (const code of view.blockers) items.push(notice('danger', 'alert', BLOCKER_TEXT[code] ?? code));
    for (const adjustment of view.plan?.adjustments ?? []) {
      const text = ADJUSTMENT_TEXT[adjustment.code];
      items.push(notice('info', 'info', typeof text === 'function' ? text(adjustment) : text ?? adjustment.code));
    }
    for (const issue of view.plan?.issues ?? []) items.push(notice('warning', 'alert', issue.text, issue.fix || null));
    if (view.plan?.installReason) items.push(notice('info', 'box', `安装方式：${view.plan.installReason}`));
    box.replaceChildren();
    if (items.length) {
      box.append(el('h3', 'settings-section-title', '提示'));
      const card = el('div', 'settings-card glass setup-notice-list');
      card.append(...items);
      box.append(card);
    }
  }

  function resultText(result) {
    if (result.timedOut) return '超时';
    const seconds = (result.durationMs / 1000).toFixed(1);
    if (result.ok) return `成功 · ${seconds}s`;
    return `失败（退出码 ${result.exitCode}）· ${seconds}s`;
  }

  function paintSteps(busy) {
    $('#setupAllowScripts').checked = view.allowScripts;
    $('#setupAllowScripts').disabled = busy || view.stale;
    const list = $('#setupSteps');
    list.replaceChildren(...view.steps.map((step) => {
      const item = el('li', 'setup-step');
      const head = el('div', 'setup-step-head');
      const label = el('div', 'setup-step-label');
      label.append(el('strong', null, KIND_LABEL[step.kind] ?? step.kind), el('code', null, step.line));
      const state = el('span', 'status-pill');
      if (view.running === step.id) {
        state.textContent = '运行中';
        state.classList.add('in_progress');
      } else if (step.result) {
        state.textContent = resultText(step.result);
        state.classList.add(step.result.ok ? 'done' : 'blocked');
      } else {
        state.textContent = '未运行';
      }
      const run = el('button', 'secondary-button small');
      run.type = 'button';
      run.dataset.step = step.id;
      run.append(icon('play'), document.createTextNode(step.result ? '再次运行' : '运行'));
      run.disabled = busy || view.stale;
      head.append(label, state, run);
      item.append(head);
      if (step.result?.output) {
        const details = el('details', 'setup-output');
        details.open = !step.result.ok;
        details.append(el('summary', null, '输出（最后部分）'), el('pre', 'verify-output', step.result.output));
        item.append(details);
      }
      return item;
    }));
    if (!view.steps.length) list.append(el('li', 'setup-step empty', '没有可运行的步骤。'));

    const failed = view.steps.find((step) => step.result && !step.result.ok);
    $('#setupRetry').hidden = !failed;
    if (failed) {
      const hint = failed.kind === 'install' && !view.allowScripts
        ? '安装失败了。如果错误来自原生模块编译，可以打开上面的「允许依赖的安装脚本」再试；也可以让环境管家看看输出。'
        : `「${KIND_LABEL[failed.kind]}」失败了。环境管家可以读取输出并给出排查建议。`;
      $('#setupRetryText').textContent = hint;
      $('#setupReplan').disabled = busy || view.stale;
    }
  }

  function paintApply(busy) {
    const list = $('#setupApply');
    const kinds = ['test', 'lint', 'build'].filter((kind) => view.plan?.scripts[kind]);
    list.replaceChildren(...kinds.map((kind) => {
      const step = view.steps.find((candidate) => candidate.id === kind);
      const proposed = step?.line ?? '';
      const current = view.configured[kind];
      const item = el('li', 'setup-apply-item');
      const label = el('label');
      const box = el('input');
      box.type = 'checkbox';
      box.value = kind;
      box.checked = !current && step?.result?.ok === true;
      box.disabled = busy || view.stale || current === proposed;
      const text = el('span');
      text.append(el('strong', null, KIND_LABEL[kind]), el('code', null, proposed));
      text.append(el('small', null, current === proposed ? '已是当前配置' : current ? `当前：${current}` : '当前未配置'));
      label.append(box, text);
      item.append(label);
      return item;
    }));
    if (!kinds.length) list.append(el('li', 'setup-apply-item empty', '计划里没有可写入的验证命令。'));
    $('#setupApplyButton').disabled = busy || view.stale || !kinds.length;
  }

  /* Actions */

  $('#setupPlan').addEventListener('click', () => act(api.plan(), { failure: '分析失败' }));
  $('#setupReplan').addEventListener('click', () => act(api.plan({ withFailure: true }), { failure: '分析失败' }));
  $('#setupCancel').addEventListener('click', () => api.cancel().then(() => render()));

  $('#setupAllowScripts').addEventListener('change', async (event) => {
    const allow = event.target.checked;
    if (allow) {
      const confirmed = await confirmAction({
        title: '允许依赖运行安装脚本？',
        body: '依赖包的 preinstall / install / postinstall 脚本会以你的用户权限在本机执行。只在你信任这个仓库的全部依赖时打开。',
        accept: '允许',
        danger: true,
      });
      if (!confirmed) {
        event.target.checked = false;
        return;
      }
    }
    await act(api.setAllowScripts(allow));
  });

  $('#setupSteps').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-step]');
    if (!button || button.disabled) return;
    act(api.runStep(button.dataset.step), { failure: '运行失败' });
  });

  $('#setupApplyButton').addEventListener('click', async () => {
    const kinds = [...$('#setupApply').querySelectorAll('input:checked')].map((box) => box.value);
    if (!kinds.length) {
      showToast('请先勾选要写入的命令。', 'info');
      return;
    }
    if (window.TaskPilotSettings.hasUnsavedChanges()) {
      showToast('设置里还有未保存的修改，请先保存或放弃。', 'error');
      return;
    }
    if (await act(api.apply(kinds), { failure: '写入失败' })) {
      await window.TaskPilotSettings.reload();
      showToast('验证命令已写入工作区配置。');
    }
  });

  window.TaskPilotSetup = { render };
})();
