// Requirement center: write a requirement, answer Product Lead's questions,
// review the proposed work packages, and publish them to the queue.
//
// Everything Product Lead wrote is rendered with textContent / DOM APIs, the
// same as work packages: it is model output and must never become markup.
//
// Loaded after renderer.js, which provides $, el, icon, withIcon, emptyHint,
// call, describeError, showToast, showView, confirmAction, appendInlineCode,
// reloadQueue and openExecution.
(function requirementsPage() {
  const STATUS_LABELS = {
    draft: '草稿',
    clarifying: '澄清中',
    answering: '待回答',
    planning: '拆解中',
    reviewing: '待确认',
    published: '已发布',
    failed: '失败',
  };
  // Pill colours reuse the work package status classes.
  const STATUS_TONES = {
    draft: 'pending', clarifying: 'in_progress', answering: 'in_review', planning: 'in_progress',
    reviewing: 'in_review', published: 'done', failed: 'blocked',
  };
  // Which stepper steps are done / current for each status.
  const STEPPER = {
    draft: { current: 'clarify', done: [] },
    clarifying: { current: 'clarify', done: [] },
    answering: { current: 'answer', done: ['clarify'] },
    planning: { current: 'plan', done: ['clarify', 'answer'] },
    reviewing: { current: 'publish', done: ['clarify', 'answer', 'plan'] },
    published: { current: null, done: ['clarify', 'answer', 'plan', 'publish'] },
  };
  const RUNNING = new Set(['clarifying', 'planning']);
  const POLL_MS = 1200;
  const MAX_TEXT = 4000;
  const MAX_ANSWER = 1000;
  const PRIORITY_LABELS = { high: '高优先级', medium: '中优先级', low: '低优先级' };

  let items = [];
  let selectedId = null;
  let composing = false;
  let pollTimer = null;
  let agentStatus = null;

  /* List */

  function needsAttention(item) {
    return item.status === 'answering' || item.status === 'reviewing' || item.status === 'failed';
  }

  function renderNavCount() {
    const count = items.filter(needsAttention).length;
    const badge = $('#requirementsCount');
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }

  function renderList() {
    const list = $('#requirementList');
    if (items.length === 0) {
      list.replaceChildren(emptyHint('inbox', '还没有需求'));
      return;
    }
    list.replaceChildren(...items.map((item) => {
      const row = el('button', `req-row${item.id === selectedId && !composing ? ' active' : ''}`);
      row.type = 'button';
      row.dataset.id = item.id;
      row.setAttribute('role', 'listitem');
      const title = el('span', 'req-row-title', item.title || item.text.slice(0, 40));
      const meta = el('span', 'req-row-meta');
      const pill = el('span', `status-pill ${STATUS_TONES[item.status]}`, STATUS_LABELS[item.status]);
      meta.append(pill, el('time', null, new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })));
      if (RUNNING.has(item.status)) meta.append(icon('spinner', 'spin'));
      row.append(title, meta);
      return row;
    }));
  }

  /* Panes */

  function showPane(name) {
    for (const pane of document.querySelectorAll('#requirementDetail .req-pane')) pane.hidden = pane.dataset.pane !== name;
  }

  async function renderContext() {
    // Tells the user up front what Product Lead will and won't see.
    const box = $('#reqContext');
    box.replaceChildren();
    try {
      const [info, agent] = await Promise.all([call(window.taskpilot.workspace.info()), loadAgentStatus()]);
      const facts = el('ul', 'req-context-list');
      facts.append(withIcon('li', null, info.configured ? 'git-branch' : 'info',
        info.configured
          ? `Architect 会读取仓库 ${info.root.split(/[\\/]/).filter(Boolean).pop()} 中与需求相关的少量已提交文件（最多 12 个），整理成接口摘要；可能含密钥的文件、未跟踪文件和二进制文件不会读取。Product Lead 只看摘要和路径列表。`
          : '还没有配置仓库，Product Lead 会按常见目录结构推测文件路径。'));
      facts.append(withIcon('li', null, 'terminal', '通过本机的 Claude Code CLI 运行，不启用任何工具，单次费用上限 1 美元。'));
      box.append(facts);
      if (!agent.available) {
        box.append(withIcon('p', 'req-warning', 'alert', ERROR_TEXT.agent_unavailable));
      }
    } catch (error) {
      console.error('Failed to read requirement context', error);
    }
  }

  const ERROR_TEXT = { agent_unavailable: describeError({ code: 'agent_unavailable' }) };

  async function loadAgentStatus() {
    if (agentStatus) return agentStatus;
    try {
      agentStatus = await call(window.taskpilot.agent.status());
    } catch {
      agentStatus = { available: false, command: null };
    }
    return agentStatus;
  }

  function startCompose() {
    composing = true;
    selectedId = null;
    stopPolling();
    renderList();
    showPane('new');
    $('#reqTextStatus').textContent = '';
    $('#reqText').setAttribute('aria-invalid', 'false');
    updateTextCount();
    renderContext();
    $('#reqText').focus();
  }

  function updateTextCount() {
    const count = [...$('#reqText').value.trim()].length;
    const counter = $('#reqTextCount');
    counter.textContent = `${count}/${MAX_TEXT}`;
    counter.classList.toggle('over', count > MAX_TEXT);
  }

  /* Detail */

  function renderStepper(item) {
    const state = STEPPER[item.status] ?? stepperForFailure(item);
    for (const step of document.querySelectorAll('#reqStepper li')) {
      step.classList.toggle('done', state.done.includes(step.dataset.step));
      step.classList.toggle('current', step.dataset.step === state.current);
      step.classList.toggle('failed', item.status === 'failed' && step.dataset.step === state.current);
    }
  }

  function stepperForFailure(item) {
    return item.failedStep === 'planning' ? { current: 'plan', done: ['clarify', 'answer'] } : { current: 'clarify', done: [] };
  }

  function agentBubble(text, { tone = '', iconName = null } = {}) {
    const bubble = el('div', `agent-message glass ${tone}`.trim());
    const head = el('div', 'agent-message-head');
    head.append(el('span', 'agent-avatar pm', 'PM'), el('strong', null, 'Product Lead'));
    if (iconName) head.append(icon(iconName, 'agent-message-icon'));
    bubble.append(head);
    if (text) {
      const body = el('p');
      appendInlineCode(body, text);
      bubble.append(body);
    }
    return bubble;
  }

  /**
   * Architect's interface summary, collapsed by default: it is what Product
   * Lead planned against, so the user can check it, but it isn't the main
   * thing on the page.
   */
  function renderInterfaces(item) {
    const info = item.interfaces;
    if (!info) return [];
    const box = el('details', 'interfaces glass');
    const summary = el('summary');
    const label = el('span', 'interfaces-label');
    label.append(el('span', 'agent-avatar arch', 'AR'), el('strong', null, 'Architect'));
    let headline;
    if (info.summary) headline = `读取了 ${info.read.length} 个文件，整理出 ${info.summary.modules.length} 个模块的接口`;
    else if (info.error) headline = `没能整理接口摘要（${describeError(info.error)}），Product Lead 只按文件列表规划`;
    else headline = '没有需要读取的代码';
    summary.append(label, el('span', 'interfaces-headline', headline));
    box.append(summary);

    const body = el('div', 'interfaces-body');
    for (const mod of info.summary?.modules ?? []) {
      const card = el('div', 'interface-module');
      card.append(withIcon('div', 'interface-path', 'file', mod.path), el('p', 'interface-purpose', mod.purpose));
      if (mod.members.length) {
        const sigs = el('pre', 'interface-members');
        sigs.textContent = mod.members.map((m) => m.signature).join('\n');
        card.append(sigs);
      }
      if (mod.dependsOn.length) card.append(el('p', 'interface-deps', `依赖 ${mod.dependsOn.join('、')}`));
      if (mod.notes.length) {
        const notes = el('ul', 'interface-notes');
        for (const note of mod.notes) notes.append(el('li', null, note));
        card.append(notes);
      }
      body.append(card);
    }
    const section = (title, entries, className = '') => {
      if (!entries?.length) return;
      const wrap = el('div', `interface-section ${className}`.trim());
      wrap.append(el('h4', null, title));
      const ul = el('ul');
      for (const entry of entries) ul.append(el('li', null, entry));
      wrap.append(ul);
      body.append(wrap);
    };
    section('仓库约定', info.summary?.conventions);
    section('不确定或缺失', info.summary?.gaps, 'gaps');
    const SKIP_LABELS = { secret: '可能含密钥', binary: '二进制', too_large: '过大', budget: '超出读取上限', file_limit: '超出文件数上限', not_tracked: '未被 git 跟踪', not_a_file: '链接或子模块' };
    section('未读取', (info.skipped ?? []).map((s) => `${s.path}（${SKIP_LABELS[s.reason] ?? s.reason}）`), 'skipped');
    if (body.childElementCount) box.append(body);
    return [box];
  }

  function renderRunning(item) {
    const label = item.status === 'planning' ? '正在拆解工作包…'
      : item.phase === 'architect' ? 'Architect 正在阅读相关代码…'
      : '正在阅读需求，准备澄清问题…';
    const bubble = agentBubble(null, { tone: 'running' });
    if (item.phase === 'architect') {
      const head = bubble.querySelector('.agent-message-head');
      head.replaceChildren(el('span', 'agent-avatar arch', 'AR'), el('strong', null, 'Architect'));
    }
    const row = el('div', 'agent-running');
    row.append(icon('spinner', 'spin'), el('span', null, label));
    const hint = el('small', null, '通常需要 20 秒到 1 分钟。可以先去做别的事，完成后这里会更新。');
    const cancel = withIcon('button', 'secondary-button small', 'x', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try {
        await call(window.taskpilot.requirements.cancel(item.id));
      } catch (error) {
        showToast(`取消失败：${describeError(error)}`);
      }
    });
    bubble.append(row, hint, cancel);
    return [bubble];
  }

  function renderFailure(item) {
    const bubble = agentBubble(describeError(item.error ?? {}), { tone: 'failed', iconName: 'alert' });
    if (item.error?.message && item.error.code !== 'agent_cancelled') {
      bubble.append(el('code', 'agent-error-detail', item.error.message));
    }
    const actions = el('div', 'req-actions');
    const step = item.failedStep === 'planning' ? 'plan' : 'clarify';
    const retry = withIcon('button', 'primary-button', 'refresh', step === 'plan' ? '重新拆解' : '重新澄清');
    retry.type = 'button';
    retry.addEventListener('click', () => runStep(item, step));
    actions.append(retry);
    if (step === 'plan') {
      const back = withIcon('button', 'secondary-button', 'arrow-left', '修改回答');
      back.type = 'button';
      back.addEventListener('click', () => editAnswers(item));
      actions.append(back);
    }
    return [bubble, actions, deleteButton(item)];
  }

  /** The question form; also used to edit answers after a plan exists. */
  function renderQuestions(item) {
    const nodes = [];
    if (item.summary) nodes.push(agentBubble(`我理解的需求：${item.summary}`));

    const form = el('form', 'req-questions');
    form.noValidate = true;
    if (item.questions.length === 0) {
      nodes.push(agentBubble('需求已经足够清楚，没有需要澄清的问题。可以直接拆解。'));
    } else {
      nodes.push(agentBubble(`开始拆解前，我有 ${item.questions.length} 个问题。没把握的可以留空，我会选一个合理的默认做法并说明。`));
      item.questions.forEach((question, index) => {
        const card = el('div', 'question-card glass');
        const label = el('label', 'question-text');
        label.htmlFor = `reqAnswer${index}`;
        label.append(el('span', 'question-index', String(index + 1)));
        const text = el('span');
        appendInlineCode(text, question.text);
        label.append(text);
        const input = el('textarea', 'field-input');
        input.id = `reqAnswer${index}`;
        input.rows = 2;
        input.maxLength = MAX_ANSWER;
        input.value = question.answer ?? '';
        input.placeholder = '你的回答（可留空）';
        input.dataset.index = String(index);
        card.append(label, input);
        form.append(card);
      });
    }
    const actions = el('div', 'req-actions');
    const submit = withIcon('button', 'primary-button', 'blocks', '开始拆解');
    submit.type = 'submit';
    actions.append(submit);
    form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      runStep(item, 'plan', readAnswers(form));
    });
    nodes.push(form, deleteButton(item));
    return nodes;
  }

  function readAnswers(form) {
    return [...form.querySelectorAll('textarea[data-index]')].map((input) => input.value);
  }

  function renderPlanPackage(pkg, index) {
    const card = el('article', 'plan-package glass');
    const head = el('div', 'plan-package-head');
    const iconBox = el('span', `task-state priority-${pkg.priority}`);
    iconBox.append(icon(pkg.icon));
    const titles = el('div', 'plan-package-titles');
    titles.append(el('span', 'plan-package-index', `工作包 ${index + 1}`), el('h3', null, pkg.title), el('p', null, pkg.description));
    const meta = el('div', 'plan-package-meta');
    const priority = el('span', 'priority');
    priority.append(el('span', `priority-dot ${pkg.priority}`), PRIORITY_LABELS[pkg.priority]);
    meta.append(priority, withIcon('span', 'task-time', 'clock', `${pkg.estimateHours}h`));
    head.append(iconBox, titles, meta);

    const tags = el('div', 'task-tags');
    tags.append(el('span', 'tag', pkg.module), ...pkg.tags.filter((t) => t !== pkg.module).map((t) => el('span', 'tag', t)));

    const steps = el('ol', 'plan-steps');
    for (const step of pkg.steps) {
      const li = el('li');
      appendInlineCode(li, step);
      steps.append(li);
    }

    const scope = el('ul', 'plan-scope');
    for (const file of pkg.fileScope) scope.append(withIcon('li', null, 'file', file));

    const acceptance = el('ul', 'plan-acceptance');
    for (const criterion of pkg.acceptance) {
      const li = withIcon('li', null, 'check-circle', criterion.text);
      if (criterion.test) li.append(withIcon('small', null, 'flask', criterion.test));
      acceptance.append(li);
    }

    const section = (title, node) => {
      const wrap = el('div', 'plan-section');
      wrap.append(el('h4', null, title), node);
      return wrap;
    };
    card.append(head, tags, section('执行指令', steps), section('文件范围', scope), section('验收条件', acceptance));
    return card;
  }

  function renderPlan(item, { published = false } = {}) {
    const plan = item.plan;
    const total = plan.packages.reduce((sum, pkg) => sum + pkg.estimateHours, 0);
    const nodes = [agentBubble(plan.summary)];
    const summary = el('div', 'plan-summary');
    summary.append(
      withIcon('span', null, 'blocks', `${plan.packages.length} 个工作包`),
      withIcon('span', null, 'clock', `合计约 ${Math.round(total * 10) / 10} 小时`),
      withIcon('span', null, 'file', `${new Set(plan.packages.flatMap((p) => p.fileScope)).size} 个文件`),
    );
    if (item.costUsd > 0) summary.append(withIcon('span', 'plan-cost', 'info', `本需求累计费用 $${item.costUsd.toFixed(3)}`));
    nodes.push(summary, ...plan.packages.map(renderPlanPackage));

    const actions = el('div', 'req-actions sticky');
    if (published) {
      const go = withIcon('button', 'primary-button', 'arrow-right', '查看工作队列');
      go.type = 'button';
      go.addEventListener('click', () => $('#queueNav').click());
      actions.append(go);
    } else {
      const publish = withIcon('button', 'primary-button', 'send', `发布 ${plan.packages.length} 个工作包`);
      publish.type = 'button';
      publish.addEventListener('click', () => publishPlan(item, publish));
      const redo = withIcon('button', 'secondary-button', 'refresh', '重新拆解');
      redo.type = 'button';
      redo.addEventListener('click', () => runStep(item, 'plan'));
      const back = withIcon('button', 'secondary-button', 'arrow-left', '修改回答');
      back.type = 'button';
      back.addEventListener('click', () => editAnswers(item));
      actions.append(back, redo, publish);
    }
    nodes.push(actions);
    if (!published) nodes.push(deleteButton(item));
    return nodes;
  }

  function deleteButton(item) {
    const wrap = el('div', 'req-delete');
    const button = withIcon('button', 'link-button danger', 'trash', '删除这个需求');
    button.type = 'button';
    button.addEventListener('click', async () => {
      const confirmed = await confirmAction({
        title: '删除这个需求？',
        body: '需求、Product Lead 的问题和拆解结果都会被删除，无法恢复。',
        accept: '删除',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await call(window.taskpilot.requirements.remove(item.id));
        selectedId = null;
        await refreshList();
        showPane(items.length ? 'empty' : 'empty');
        showToast('需求已删除。');
      } catch (error) {
        showToast(`删除失败：${describeError(error)}`);
      }
    });
    wrap.append(button);
    return wrap;
  }

  function renderDetail(item) {
    showPane('detail');
    const pill = $('#reqStatus');
    pill.className = `status-pill ${STATUS_TONES[item.status]}`;
    pill.textContent = STATUS_LABELS[item.status];
    $('#reqHeading').textContent = item.title || '未命名需求';
    $('#reqOriginal').textContent = item.text;
    renderStepper(item);

    let nodes;
    if (RUNNING.has(item.status)) nodes = renderRunning(item);
    else if (item.status === 'failed') nodes = renderFailure(item);
    else if (item.status === 'answering' || item.status === 'draft') nodes = renderQuestions(item);
    else if (item.status === 'reviewing') nodes = renderPlan(item);
    else if (item.status === 'published') nodes = [agentBubble(`已发布 ${item.packages.length} 个工作包到工作队列。`, { iconName: 'check-circle' }), ...renderPlan(item, { published: true })];
    else nodes = [];
    // The summary sits above the conversation once it exists.
    const interfaces = RUNNING.has(item.status) && item.phase === 'architect' ? [] : renderInterfaces(item);
    $('#reqBody').replaceChildren(...interfaces, ...nodes);
  }

  /* Actions */

  async function runStep(item, step, answers) {
    try {
      const next = step === 'plan'
        ? await call(window.taskpilot.requirements.plan(item.id, answers))
        : await call(window.taskpilot.requirements.clarify(item.id));
      upsert(next);
      renderDetail(next);
      startPolling();
    } catch (error) {
      showToast(`操作失败：${describeError(error)}`);
    }
  }

  /** Back to the question form with the current answers, discarding the plan. */
  async function editAnswers(item) {
    try {
      const next = await call(window.taskpilot.requirements.answer(item.id, item.questions.map((q) => q.answer ?? '')));
      upsert(next);
      renderDetail(next);
    } catch (error) {
      showToast(`操作失败：${describeError(error)}`);
    }
  }

  async function publishPlan(item, button) {
    button.disabled = true;
    try {
      const next = await call(window.taskpilot.requirements.publish(item.id));
      upsert(next);
      renderDetail(next);
      await reloadQueue();
      showToast(`已发布 ${next.packages.length} 个工作包到工作队列。`);
    } catch (error) {
      button.disabled = false;
      showToast(`发布失败：${describeError(error)}`);
    }
  }

  async function submitNew(event) {
    event.preventDefault();
    const text = $('#reqText').value;
    const status = $('#reqTextStatus');
    const count = [...text.trim()].length;
    const invalid = count === 0 ? '请先描述需求。' : count > MAX_TEXT ? `最多 ${MAX_TEXT} 个字符。` : null;
    status.className = `field-status${invalid ? ' error' : ''}`;
    status.textContent = invalid ?? '';
    $('#reqText').setAttribute('aria-invalid', String(Boolean(invalid)));
    if (invalid) {
      $('#reqText').focus();
      return;
    }
    const button = $('#submitRequirement');
    button.disabled = true;
    try {
      const item = await call(window.taskpilot.requirements.create({ title: $('#reqTitle').value, text }));
      $('#reqTitle').value = '';
      $('#reqText').value = '';
      composing = false;
      selectedId = item.id;
      upsert(item);
      renderList();
      renderDetail(item);
      startPolling();
    } catch (error) {
      if (error.field === 'text') {
        status.className = 'field-status error';
        status.textContent = describeError(error);
      } else {
        showToast(`提交失败：${describeError(error)}`);
      }
    } finally {
      button.disabled = false;
    }
  }

  /* Data and polling */

  function upsert(item) {
    const index = items.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) items.unshift(item);
    else items[index] = item;
    renderNavCount();
  }

  async function refreshList() {
    try {
      items = await call(window.taskpilot.requirements.list());
    } catch (error) {
      console.error('Failed to load requirements', error);
      items = [];
    }
    renderList();
    renderNavCount();
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  /**
   * While any requirement is running, re-reads the list; re-renders the open
   * one only when its status changes, so typing in answers isn't disturbed.
   */
  function startPolling() {
    stopPolling();
    const tick = async () => {
      // Status plus phase, so the Architect → Product Lead handoff re-renders too.
      const key = (item) => `${item.status}:${item.phase ?? ''}`;
      const before = new Map(items.map((item) => [item.id, key(item)]));
      await refreshList();
      const open = items.find((item) => item.id === selectedId);
      if (open && !composing && !requirementsView.hidden && before.get(open.id) !== key(open)) {
        renderDetail(open);
        if (!RUNNING.has(open.status)) announce(open);
      }
      if (items.some((item) => RUNNING.has(item.status))) pollTimer = setTimeout(tick, POLL_MS);
    };
    pollTimer = setTimeout(tick, POLL_MS);
  }

  function announce(item) {
    if (item.status === 'answering') showToast('Product Lead 提出了澄清问题。', 'info');
    else if (item.status === 'reviewing') showToast('工作包拆解完成，请确认。', 'info');
    else if (item.status === 'failed' && item.error?.code !== 'agent_cancelled') showToast(`Product Lead 运行失败：${describeError(item.error)}`);
  }

  function select(id) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    composing = false;
    selectedId = id;
    renderList();
    renderDetail(item);
  }

  $('#requirementList').addEventListener('click', (event) => {
    const row = event.target.closest('.req-row');
    if (row) select(row.dataset.id);
  });
  $('#newRequirement').addEventListener('click', startCompose);
  $('#emptyNewRequirement').addEventListener('click', startCompose);
  $('#newRequirementForm').addEventListener('submit', submitNew);
  $('#reqText').addEventListener('input', () => {
    updateTextCount();
    // Clear a previous "required" error once the user starts typing.
    const status = $('#reqTextStatus');
    if (status.classList.contains('error') && $('#reqText').value.trim()) {
      status.className = 'field-status';
      status.textContent = '';
      $('#reqText').setAttribute('aria-invalid', 'false');
    }
  });
  // ⌘↩ submits the requirement from the textarea.
  $('#reqText').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('#newRequirementForm').requestSubmit();
  });

  async function open({ compose = false, id = null } = {}) {
    showView('requirements');
    await refreshList();
    if (compose) startCompose();
    else if (id || selectedId) select(id ?? selectedId);
    else if (items.length) select(items[0].id);
    else showPane('empty');
    if (items.some((item) => RUNNING.has(item.status))) startPolling();
  }

  // Load counts for the sidebar badge on startup, without opening the view.
  refreshList().then(() => {
    if (items.some((item) => RUNNING.has(item.status))) startPolling();
  });

  window.TaskPilotRequirements = { open };
})();
