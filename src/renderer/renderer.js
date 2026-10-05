// All task content is inserted with DOM APIs / textContent, never innerHTML:
// work package text is authored by AI agents and must never become markup.
const PRIORITY_LABELS = { high: '高优先级', medium: '中优先级', low: '低优先级' };

// Human-triggerable transitions, in the order they should appear.
const ACTIONS = [
  { name: 'claim', label: '开始执行', icon: 'play', primary: true },
  { name: 'submit_for_review', label: '提交审查', icon: 'send', primary: true },
  { name: 'unblock', label: '解除阻塞', icon: 'unlock', primary: true },
  { name: 'report_deviation', label: '报告偏差', icon: 'flag' },
  { name: 'block', label: '标记阻塞', icon: 'ban' },
  { name: 'release', label: '放回队列', icon: 'undo' },
];

const ERROR_HINTS = {
  no_workspace: '尚未配置工作区，请先在设置里指定仓库路径。',
  not_configured: '工作区没有配置这个命令。',
  command_missing: '找不到可执行文件，请检查命令配置。',
  no_baseline: '请先领取工作包。',
  not_a_repo: '该目录不在 git 仓库中。',
  root_not_absolute: '请填写绝对路径。',
  root_not_found: '目录不存在。',
  shell_syntax: '不支持 shell 语法，请改用 package.json 脚本。',
  unterminated_quote: '引号没有闭合。',
  invalid_command: '命令格式不正确。',
  name_too_long: '最多 40 个字符。',
  invalid_name: '名字不能包含控制字符。',
  invalid_choice: '选项无效。',
  open_failed: '系统无法打开这个目录。',
  agent_unavailable: '找不到 Claude Code CLI。请确认已安装 `claude`，或在「设置 → 运行环境」里改为从登录 shell 读取 PATH。',
  agent_timeout: '智能体超过 3 分钟没有完成，已停止。',
  agent_cancelled: '已取消。',
  agent_budget: '本次调用超出了 1 美元的费用上限，已停止。',
  agent_bad_output: '智能体返回的内容不符合格式要求，已丢弃。可以重试。',
  agent_interrupted: 'TaskPilot 在智能体运行时退出了。',
  agent_failed: '智能体运行失败。',
  review_running: 'QA 正在审查。',
  invalid_state: '当前状态下不能执行这个操作。',
  required: '请填写这一项。',
  too_long: '内容太长了。',
  invalid_text: '内容包含控制字符。',
  env_no_plan: '请先让环境管家分析环境。',
  env_stale: '工作区已经换了仓库，请重新分析环境。',
  env_busy: '环境管家正在忙，请等当前操作结束。',
  env_blocked: '仓库还有阻塞问题，这一步不能运行。',
};

const $ = (selector) => document.querySelector(selector);
const taskList = $('#taskList');
const queueView = $('#queueView');
const executionView = $('#executionView');
const settingsView = $('#settingsView');
const requirementsView = $('#requirementsView');
const deviationModal = $('#deviationModal');
const toast = $('#toast');
const toastText = $('#toastText');

let tasks = [];
let current = null; // the work package open in the execution view
let lastFocused = null;
let toastTimer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const { createIcon, hydrateIcons } = window.TaskPilotIcons;
const icon = (name, className) => createIcon(document, name, className);

/** An element holding an icon followed by text, e.g. a button label. */
function withIcon(tag, className, iconName, text) {
  const node = el(tag, className);
  node.append(icon(iconName));
  if (text !== undefined) node.append(text);
  return node;
}

function emptyHint(iconName, text) {
  return withIcon('p', 'empty-hint', iconName, text);
}

// Swap the static markup's <i data-icon> placeholders for SVGs before any
// rendering code looks them up.
hydrateIcons(document);

/** Unwraps the {ok, data} | {ok, error} envelope every IPC call returns. */
async function call(promise) {
  const response = await promise;
  if (!response?.ok) {
    const error = new Error(response?.error?.message ?? 'IPC 调用失败');
    error.code = response?.error?.code ?? 'unknown';
    // Which settings input the failure belongs to, when the main process knows.
    if (response?.error?.field) error.field = response.error.field;
    throw error;
  }
  return response.data;
}

function describeError(error) {
  return ERROR_HINTS[error.code] ?? error.message;
}

const TOAST_ICONS = { success: 'check', error: 'alert', info: 'info' };

/**
 * `tone` defaults from the wording: messages ending in 失败 or carrying an
 * error description read as errors. Pass it explicitly when that guess is off.
 */
function showToast(message, tone = /失败|无效|无法/.test(message) ? 'error' : 'success') {
  toastText.textContent = message;
  toast.classList.remove('success', 'error', 'info');
  toast.classList.add('show', tone);
  $('#toastIcon').replaceChildren(icon(TOAST_ICONS[tone] ?? 'check'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2800);
}

// Splits "foo `bar` baz" into text nodes and <code> elements.
function appendInlineCode(parent, text) {
  text.split('`').forEach((part, index) => {
    if (!part) return;
    parent.append(index % 2 === 1 ? el('code', null, part) : document.createTextNode(part));
  });
}

function renderTaskItem(task) {
  const item = el('button', 'task-item');
  item.type = 'button';
  item.dataset.taskId = task.id;

  // `task.icon` is an icon name from tasks.js; an unknown name renders blank
  // rather than falling back to the raw string.
  const state = el('div', `task-state priority-${task.priority}`);
  state.append(icon(task.icon));

  const main = el('div', 'task-main');
  const tags = el('div', 'task-tags');
  tags.append(el('span', `status-pill ${task.status}`, task.statusLabel));
  task.tags.forEach((tag) => tags.append(el('span', 'tag', tag)));
  main.append(el('div', 'task-title', task.title), el('div', 'task-description', task.description), tags);

  const meta = el('div', 'task-side-meta');
  const priority = el('span', 'priority');
  priority.append(el('span', `priority-dot ${task.priority}`), PRIORITY_LABELS[task.priority]);
  meta.append(priority, withIcon('span', 'task-time', 'clock', task.estimate));

  const side = el('div', 'task-side');
  side.append(meta, icon('chevron-right', 'task-go'));

  item.append(state, main, side);
  return item;
}

function renderTasks() {
  taskList.replaceChildren(...tasks.map(renderTaskItem));
  const pending = tasks.filter((task) => task.status !== 'done').length;
  $('#queueCount').textContent = pending;
  $('#pendingCount').textContent = pending;
}

function renderHeading(now = new Date()) {
  const hour = now.getHours();
  $('#greeting').textContent = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  $('#todayLabel').textContent = now
    .toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    .toUpperCase();
}

const VIEWS = { queue: queueView, execution: executionView, settings: settingsView, requirements: requirementsView };

/** Shows exactly one top-level view and syncs the sidebar highlight. */
function showView(name) {
  for (const [key, view] of Object.entries(VIEWS)) view.hidden = key !== name;
  $('#queueNav').classList.toggle('active', name === 'queue' || name === 'execution');
  $('#requirementsNav').classList.toggle('active', name === 'requirements');
  $('#settingsLink').classList.toggle('active', name === 'settings');
}

/**
 * Leaving settings with unsaved edits asks first. Resolves true when it is
 * fine to navigate away.
 */
async function confirmLeaveSettings() {
  if (settingsView.hidden || !window.TaskPilotSettings?.hasUnsavedChanges()) return true;
  const choice = await confirmAction({
    title: '保存修改？',
    body: '设置里有未保存的修改。离开后这些修改会丢失。',
    accept: '保存',
    alternate: '不保存',
  });
  if (choice === 'accept') return window.TaskPilotSettings.saveAll();
  if (choice === 'alternate') {
    window.TaskPilotSettings.discardAll();
    return true;
  }
  return false;
}

async function showQueue() {
  if (!(await confirmLeaveSettings())) return;
  current = null;
  showView('queue');
}

function showSettings(page) {
  current = null;
  window.TaskPilotSettings.open(page);
}

/* Profile and appearance */

let profile = { displayName: '', avatarColor: 'sunset', initials: '' };
const AVATAR_COLOR_NAMES = ['sunset', 'ocean', 'violet', 'forest', 'graphite'];

/** Avatar text is derived on the client too, so previews follow typing. */
function initialsOf(name) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  const words = trimmed.split(/[\s._-]+/).filter(Boolean);
  const first = [...words[0]][0];
  if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(first)) return first;
  const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + last).toUpperCase();
}

/** Paints an avatar element: initials when there is a name, a user icon otherwise. */
function paintAvatar(node, { displayName, avatarColor }) {
  const text = initialsOf(displayName);
  node.classList.remove(...AVATAR_COLOR_NAMES, 'empty');
  node.classList.add(AVATAR_COLOR_NAMES.includes(avatarColor) ? avatarColor : 'sunset');
  if (text) node.textContent = text;
  else {
    node.classList.add('empty');
    node.replaceChildren(icon('user'));
  }
}

function renderGreetingName() {
  $('#greetingName').textContent = profile.displayName ? `，${profile.displayName}` : '';
}

/** Applies saved preferences to everything outside the settings page. */
function applyPreferences(prefs) {
  profile = prefs.profile;
  paintAvatar($('#topAvatar'), profile);
  paintAvatar($('#navAvatar'), profile);
  renderGreetingName();
  // The main process sets nativeTheme.themeSource, which drives the CSS
  // colour scheme; the page only needs to know about vibrancy.
  document.body.classList.toggle('vibrancy', prefs.appearance.vibrancy && /mac/i.test(navigator.platform));
}

/* Confirm dialog */

const confirmModal = $('#confirmModal');
let resolveConfirm = null;

/**
 * Promise-based confirm. Resolves true/false, or 'accept' / 'alternate' /
 * false when an `alternate` button is offered.
 */
function confirmAction({ title, body, accept, alternate, danger = false }) {
  $('#confirmTitle').textContent = title;
  $('#confirmBody').textContent = body;
  const acceptButton = $('#confirmAccept');
  acceptButton.textContent = accept;
  acceptButton.classList.toggle('danger', danger);
  $('#confirmBadge').classList.toggle('neutral', !danger);

  // The alternate button is created on demand so the default dialog stays two-button.
  confirmModal.querySelector('.confirm-alternate')?.remove();
  if (alternate) {
    const alt = el('button', 'secondary-button confirm-alternate', alternate);
    alt.type = 'button';
    alt.addEventListener('click', () => settleConfirm('alternate'));
    acceptButton.before(alt);
  }

  lastFocused = document.activeElement;
  confirmModal.hidden = false;
  $('#confirmCancel').focus();
  return new Promise((resolve) => {
    resolveConfirm = (value) => resolve(alternate ? value : value === 'accept');
  });
}

function settleConfirm(value) {
  if (confirmModal.hidden) return;
  confirmModal.hidden = true;
  lastFocused?.focus();
  const resolve = resolveConfirm;
  resolveConfirm = null;
  resolve?.(value);
}

$('#confirmAccept').addEventListener('click', () => settleConfirm('accept'));
$('#confirmCancel').addEventListener('click', () => settleConfirm(false));
confirmModal.addEventListener('click', (event) => {
  if (event.target === confirmModal) settleConfirm(false);
});

async function reloadQueue() {
  tasks = await call(window.taskpilot.listTasks());
  renderTasks();
}

/** Reflects workspace status in the top bar and sidebar card. */
function renderWorkspaceStatus(info) {
  const configured = info?.configured === true;
  $('#repoDot').classList.toggle('off', !configured);
  $('#syncIcon').classList.toggle('off', !configured);
  if (!configured) {
    $('#workspaceName').textContent = '未配置工作区';
    $('#syncTitle').textContent = '未配置工作区';
    $('#syncDetail').textContent = '前往设置指定仓库';
    return;
  }
  const name = info.root.split(/[\\/]/).filter(Boolean).pop() ?? info.root;
  $('#workspaceName').textContent = info.branch ? `${name} / ${info.branch}` : name;
  $('#syncTitle').textContent = info.dirty ? `${info.changedFiles} 个文件有改动` : '工作区干净';
  $('#syncDetail').textContent = `${info.commit.slice(0, 8)} · ${info.branch ?? 'detached'}`;
}

async function refreshWorkspaceStatus() {
  try {
    const info = await call(window.taskpilot.workspace.info());
    renderWorkspaceStatus(info);
    return info;
  } catch (error) {
    // A configured root that has since vanished or broken lands here.
    console.error('Failed to read workspace info', error);
    renderWorkspaceStatus(null);
    $('#syncDetail').textContent = describeError(error);
    return null;
  }
}

function renderSteps(task) {
  const done = new Set(task.completedSteps);
  const claimed = task.status === 'in_progress';
  $('#execStepProgress').textContent = `${done.size} / ${task.steps.length} 已完成`;
  $('#execStepBar').style.width = `${task.steps.length ? (done.size / task.steps.length) * 100 : 0}%`;

  $('#execSteps').replaceChildren(...task.steps.map((step, index) => {
    const item = el('li', `step-item${done.has(index) ? ' done' : ''}`);
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = done.has(index);
    box.disabled = !claimed; // progress only makes sense while executing
    box.dataset.stepIndex = String(index);
    // The native checkbox stays in the DOM for keyboard and screen readers;
    // .step-check is its visual stand-in (numbered until ticked).
    const check = el('span', 'step-check');
    check.append(icon('check'));
    const text = el('span', 'step-text');
    appendInlineCode(text, step);
    label.append(box, check, text);
    item.append(label);
    return item;
  }));
}

/** Acceptance rows; `matched` comes from the last verification run or review, if any. */
function renderAcceptance(task, matched) {
  const byText = new Map((matched ?? []).map((entry) => [entry.text, entry]));
  $('#execAcceptance').replaceChildren(...task.acceptance.map((criterion) => {
    const result = byText.get(criterion.text);
    // Reviews stored before evidence statuses existed carry only the flags.
    const legacy = result && (result.manual ? 'manual' : result.verified ? 'verified' : result.missing ? 'missing' : 'failed');
    const status = result?.status ?? legacy ?? (criterion.test ? null : 'manual');
    const tone = { verified: ' verified', failed: ' failed', missing: ' failed', unverifiable: ' unverifiable' }[status] ?? '';
    const row = el('div', `criterion${tone}`);
    const mark = el('span', 'criterion-mark');
    mark.append(icon({ verified: 'check-circle', failed: 'x-circle', missing: 'x-circle', unverifiable: 'alert' }[status] ?? 'circle'));
    row.append(mark);

    const body = el('div');
    body.append(el('span', 'criterion-text', criterion.text));
    if (criterion.test) {
      const note = status ? reviewModel.CRITERION_EVIDENCE[status] : '待验证';
      body.append(withIcon('span', 'criterion-test', 'flask', `${criterion.test} · ${note}`));
      if (result?.alreadyPassing) body.append(withIcon('span', 'criterion-test warn-text', 'info', '改动前就已通过，不能证明这次改动有效'));
    } else {
      body.append(withIcon('span', 'criterion-test', 'info', '需人工确认'));
    }
    row.append(body);
    return row;
  }));
}

function evidenceRow(item) {
  const line = reviewModel.evidenceLine(item);
  const row = el('div', 'evidence-row');
  const pill = el('span', `status-pill ${line.tone}`, reviewModel.EVIDENCE_STATUS[item.status]?.label ?? item.status);
  row.append(pill, el('span', 'evidence-text', line.text));
  const lists = [['新增失败', item.newFailures], ['基线上已失败', item.preexisting], ['本次修复', item.fixed]];
  for (const [title, names] of lists) {
    if (!names?.length) continue;
    const details = el('details', 'evidence-list');
    details.append(el('summary', null, `${title}（${names.length}）`));
    names.forEach((name) => details.append(el('div', null, name)));
    row.append(details);
  }
  return row;
}

/* Baseline */

let baselineTimer = null;

function renderBaseline(task) {
  const box = $('#execBaselineChecks');
  const { text, canRemeasure } = reviewModel.baselineText(task.baselineChecks);
  box.hidden = !task.baseline || !text;
  $('#execBaselineText').textContent = text;
  box.classList.toggle('measuring', task.baselineChecks?.status === 'measuring');
  $('#remeasureBaseline').hidden = !(canRemeasure && task.status === 'in_progress');

  window.clearTimeout(baselineTimer);
  baselineTimer = null;
  // Claiming starts the measurement in the background; follow it.
  const pending = task.baseline && (!task.baselineChecks || task.baselineChecks.status === 'measuring');
  if (pending) {
    const id = task.id;
    baselineTimer = window.setTimeout(async () => {
      if (current?.id !== id) return;
      try {
        const fresh = await call(window.taskpilot.getTask(id));
        if (current?.id !== id) return;
        current = { ...current, baselineChecks: fresh.baselineChecks };
        renderBaseline(current);
      } catch {
        // Try again on the next render.
      }
    }, 1000);
  }
}

$('#remeasureBaseline').addEventListener('click', async () => {
  if (!current) return;
  try {
    current = await call(window.taskpilot.measureBaseline(current.id));
    // The new measurement replaces the old record once it starts.
    current = { ...current, baselineChecks: { status: 'measuring', checks: {} } };
    renderBaseline(current);
  } catch (error) {
    showToast(`无法重新测量：${describeError(error)}`, 'error');
  }
});

function renderDeviations(task) {
  const panel = $('#deviationPanel');
  panel.hidden = task.deviations.length === 0;
  $('#execDeviations').replaceChildren(...task.deviations.map((deviation) => {
    const item = el('div', 'deviation-item');
    const note = el('p');
    appendInlineCode(note, deviation.note);
    item.append(note);
    const meta = el('small');
    meta.append(withIcon('span', null, 'clock', new Date(deviation.reportedAt).toLocaleString('zh-CN')));
    if (deviation.stepIndex !== null) meta.append(withIcon('span', null, 'list-checks', `指令 ${deviation.stepIndex + 1}`));
    if (deviation.filePath) meta.append(withIcon('span', null, 'file', deviation.filePath));
    item.append(meta);
    return item;
  }));
}

/* QA review */

const REVIEW_POLL_MS = 1500;
const REVIEW_REASONS = {
  no_changes: '相对基线没有任何改动',
  tests_failed: '测试未通过',
  acceptance_tests: '有验收条件的关联测试未通过',
  qa_rejected: 'QA 判定不通过',
  blocker: 'QA 发现了阻断问题',
  criteria_unmet: '有验收条件未满足',
};
const SEVERITY_LABELS = { blocker: '阻断', major: '重要', minor: '次要' };
const CRITERION_LABELS = { met: '满足', unmet: '未满足', unclear: '无法判断' };
const CRITERION_ICONS = { met: 'check-circle', unmet: 'x-circle', unclear: 'circle' };
const SKIP_LABELS = {
  rename: '重命名',
  outside_workspace: '在工作区外',
  secret: '疑似敏感文件',
  binary: '二进制文件',
  file_limit: '超出文件数上限',
  unreadable: '无法读取',
  too_large: '改动过大',
  budget: '超出审查总量',
};
let reviewTimer = null;

function reviewButton(action, iconName, label) {
  const button = withIcon('button', 'secondary-button small', iconName, label);
  button.type = 'button';
  button.dataset.review = action;
  return button;
}

function reviewSection(title, children) {
  const section = el('div', 'review-section');
  section.append(el('h3', null, title), ...children);
  return section;
}

function renderReviewResult(task, review) {
  const nodes = [];
  if (review.reasons.length > 0) {
    const list = el('ul', 'review-reasons');
    review.reasons.forEach((reason) => list.append(withIcon('li', null, 'x', REVIEW_REASONS[reason] ?? reason)));
    nodes.push(list);
  }
  if (review.report) {
    const summary = el('p', 'review-summary');
    appendInlineCode(summary, review.report.summary);
    nodes.push(summary);

    const criteria = review.report.criteria.map((criterion) => {
      const row = el('div', `review-criterion ${criterion.status}`);
      row.append(icon(CRITERION_ICONS[criterion.status]));
      const body = el('div');
      body.append(el('span', 'criterion-text', task.acceptance[criterion.index]?.text ?? `条件 ${criterion.index + 1}`));
      const note = el('small');
      note.append(`${CRITERION_LABELS[criterion.status]}${criterion.note ? '：' : ''}`);
      if (criterion.note) appendInlineCode(note, criterion.note);
      body.append(note);
      row.append(body);
      return row;
    });
    if (criteria.length) nodes.push(reviewSection('验收条件', criteria));

    const issues = review.report.issues.map((issue) => {
      const row = el('div', `review-issue ${issue.severity}`);
      row.append(el('span', `severity-tag ${issue.severity}`, SEVERITY_LABELS[issue.severity]));
      const body = el('div');
      const text = el('p');
      appendInlineCode(text, issue.text);
      body.append(text);
      if (issue.file) body.append(withIcon('small', null, 'file', issue.line ? `${issue.file}:${issue.line}` : issue.file));
      row.append(body);
      return row;
    });
    nodes.push(reviewSection(`问题（${issues.length}）`, issues.length ? issues : [emptyHint('check', 'QA 没有发现问题。')]));
  }
  if (review.checks?.length) {
    nodes.push(reviewSection('检查证据', review.checks.map((item) => evidenceRow(item))));
  }
  if (review.attention?.length) {
    nodes.push(reviewSection('需要人工确认', review.attention.map((item) =>
      withIcon('div', 'review-attention', 'alert', reviewModel.attentionText(item, task.acceptance)))));
  }
  if (review.diff.skipped.length > 0) {
    nodes.push(reviewSection('未审查的文件', review.diff.skipped.map((skip) =>
      withIcon('div', 'review-skipped', 'file', `${skip.path} · ${SKIP_LABELS[skip.reason] ?? skip.reason}`))));
  }

  const meta = el('div', 'review-meta');
  const v = review.verification;
  meta.append(withIcon('span', null, 'flask', v
    ? `测试 ${v.summary.passed}/${v.summary.total} 通过${v.summary.ok ? '' : `（退出码 ${v.exitCode}${v.timedOut ? '，超时' : ''}）`}`
    : '未配置测试命令'));
  meta.append(withIcon('span', null, 'diff', `审查了 ${review.diff.files.length} 个文件`));
  if (review.costUsd > 0) meta.append(withIcon('span', null, 'activity', `费用 $${review.costUsd.toFixed(4)}`));
  if (review.finishedAt) meta.append(withIcon('span', null, 'clock', new Date(review.finishedAt).toLocaleString('zh-CN')));
  nodes.push(meta);
  if (v?.failing.length) {
    const list = el('div', 'verify-failures');
    v.failing.forEach((name) => list.append(withIcon('div', null, 'x', name)));
    nodes.push(list);
  }
  return nodes;
}

function renderReview(task) {
  const panel = $('#reviewPanel');
  const review = task.review;
  panel.hidden = !review;
  if (!review) return;
  const iconBox = $('#reviewIcon');
  const actions = [];
  let body = [];
  let hint;
  let tone = '';
  let iconName = 'bot';

  if (review.status === 'running') {
    hint = '正在运行测试并审查改动…';
    iconName = 'spinner';
    actions.push(reviewButton('cancel', 'x', '取消'));
  } else if (review.status === 'failed') {
    hint = `审查没有完成：${describeError(review.error)}`;
    tone = 'danger';
    iconName = 'alert';
  } else if (review.status === 'passed') {
    hint = '已通过，进入验收。';
    tone = 'success';
    iconName = 'check-circle';
    body = renderReviewResult(task, review);
  } else {
    hint = '未通过，已退回给你修改。修改后可再次提交审查。';
    tone = 'danger';
    iconName = 'x-circle';
    body = renderReviewResult(task, review);
  }
  // Retry is only possible while the package still waits in review.
  if (review.status === 'failed' && task.status === 'in_review') actions.push(reviewButton('retry', 'refresh', '重新审查'));

  iconBox.className = `panel-icon${tone ? ` ${tone}` : ''}`;
  iconBox.replaceChildren(icon(iconName, review.status === 'running' ? 'spin' : undefined));
  $('#reviewHint').textContent = hint;
  $('#reviewActions').replaceChildren(...actions);
  $('#reviewBody').replaceChildren(...body);
}

function stopReviewPolling() {
  window.clearTimeout(reviewTimer);
  reviewTimer = null;
}

/** Re-reads the open package while QA runs, until the review settles. */
function watchReview() {
  stopReviewPolling();
  if (current?.review?.status !== 'running') return;
  const id = current.id;
  reviewTimer = window.setTimeout(async () => {
    reviewTimer = null;
    let task;
    try {
      task = await call(window.taskpilot.getTask(id));
    } catch {
      if (current?.id === id) watchReview();
      return;
    }
    if (current?.id !== id) return; // the user moved on
    if (task.review?.status === 'running') {
      current = task;
      watchReview();
      return;
    }
    await reloadCurrent();
    announceReview(task.review);
  }, REVIEW_POLL_MS);
}

function announceReview(review) {
  if (!review) return;
  if (review.status === 'passed') showToast('QA 审查通过，进入验收。');
  else if (review.status === 'rejected') showToast('QA 审查未通过，请查看问题。', 'error');
  else if (review.status === 'failed' && review.error?.code !== 'agent_cancelled') showToast(`QA 审查失败：${describeError(review.error)}`);
}

async function runReviewAction(action) {
  try {
    if (action === 'cancel') await call(window.taskpilot.review.cancel(current.id));
    else await call(window.taskpilot.review.retry(current.id));
    await reloadCurrent();
  } catch (error) {
    showToast(`操作失败：${describeError(error)}`);
  }
}

function churnStat(change) {
  const stat = el('span', 'scope-churn');
  stat.append(el('span', 'added', `+${change.added}`), ' ', el('span', 'removed', `-${change.removed}`));
  return stat;
}

function scopeRow(filePath, kind, churn) {
  const labels = { touched: '已改动', untouched: '未改动', out: '超出范围' };
  const row = el('div', `scope-row ${kind}`);
  row.append(icon(kind === 'out' ? 'alert' : 'file', 'scope-file'), el('span', 'scope-path', filePath));
  if (churn?.untracked) row.append(el('span', 'scope-tag new', '新文件'));
  if (churn && !churn.binary) row.append(churnStat(churn));
  row.append(el('span', `scope-tag ${kind}`, labels[kind]));
  return row;
}

function renderScope(task, diff) {
  const churnByPath = new Map((diff?.changes ?? []).map((change) => [change.path, change]));
  const scope = diff?.scope;
  const rows = [];

  if (!scope) {
    // Not claimed yet: show the declared scope without churn.
    rows.push(...task.fileScope.map((filePath) => scopeRow(filePath, 'untouched')));
  } else {
    rows.push(...scope.inScope.map((p) => scopeRow(p, 'touched', churnByPath.get(p))));
    rows.push(...scope.untouched.map((p) => scopeRow(p, 'untouched')));
    rows.push(...scope.outOfScope.map((p) => scopeRow(p, 'out', churnByPath.get(p))));
  }
  $('#execScope').replaceChildren(...rows);
}

// git prints several header lines before the hunks; they are neither
// additions nor deletions even when they start with + or -.
const DIFF_META = /^(diff |index |new file |deleted file |old mode |new mode |similarity |rename |Binary files )/;

function renderDiffLine(line) {
  const kind = DIFF_META.test(line) || line.startsWith('+++') || line.startsWith('---') ? 'meta'
    : line.startsWith('@@') ? 'hunk'
    : line.startsWith('+') ? 'add'
    : line.startsWith('-') ? 'del'
    : '';
  return el('div', `diff-line ${kind}`.trim(), line);
}

/** Fetches one file's patch on expand, so opening the page stays cheap. */
async function loadDiffBody(taskId, filePath, body) {
  body.replaceChildren(el('div', 'diff-line meta', '加载中…'));
  try {
    const patch = await call(window.taskpilot.diff.file(taskId, filePath));
    const lines = patch.split('\n').filter((line) => line !== '');
    body.replaceChildren(...(lines.length ? lines.map(renderDiffLine) : [el('div', 'diff-line meta', '无文本差异')]));
  } catch (error) {
    body.replaceChildren(el('div', 'diff-line del', describeError(error)));
  }
}

function renderDiff(task, diff) {
  const container = $('#execDiff');
  const changes = diff?.changes ?? [];
  if (!task.baseline) {
    container.replaceChildren(emptyHint('play', '领取工作包后可查看改动。'));
    return;
  }
  if (changes.length === 0) {
    container.replaceChildren(emptyHint('check-circle', '相对基线还没有改动。'));
    return;
  }

  container.replaceChildren(...changes.map((change) => {
    const file = el('div', 'diff-file');
    const header = el('button', 'diff-file-header');
    header.type = 'button';
    header.append(icon('chevron-right', 'diff-chevron'), el('span', 'scope-path', change.path));
    if (change.untracked) header.append(el('span', 'scope-tag new', '新文件'));
    if (!change.binary) header.append(churnStat(change));

    const body = el('div', 'diff-body');
    body.hidden = true;
    header.setAttribute('aria-expanded', 'false');
    header.addEventListener('click', () => {
      const show = body.hidden;
      body.hidden = !show;
      header.setAttribute('aria-expanded', String(show));
      if (show && !body.dataset.loaded) {
        body.dataset.loaded = '1';
        if (change.binary) body.replaceChildren(el('div', 'diff-line meta', '二进制文件'));
        else loadDiffBody(task.id, change.path, body);
      }
    });

    file.append(header, body);
    return file;
  }));
}

function renderActions(task) {
  const allowed = new Set(task.humanTransitions);
  const buttons = ACTIONS.filter((action) => allowed.has(action.name)).map((action) => {
    const className = action.primary ? 'primary-button' : `secondary-button${action.name === 'report_deviation' ? ' danger' : ''}`;
    const button = withIcon('button', className, action.icon, action.label);
    button.type = 'button';
    button.dataset.transition = action.name;
    return button;
  });
  $('#execActions').replaceChildren(...buttons);

  const notice = $('#execNotice');
  notice.hidden = buttons.length > 0;
  $('#execNoticeText').textContent = buttons.length > 0
    ? ''
    : `当前状态「${task.statusLabel}」由 AI 团队推进，你无需操作。`;
}

function renderExecution(task, { diff, acceptance } = {}) {
  $('#execTitle').textContent = task.title;
  $('#execIntro').textContent = task.intro;
  const badge = $('#execStatus');
  badge.className = `status-badge status-pill ${task.status}`;
  badge.textContent = task.statusLabel;
  $('#execPriorityDot').className = `priority-dot ${task.priority}`;
  $('#execPriority').textContent = PRIORITY_LABELS[task.priority];
  $('#execModule').textContent = `${task.module} 模块`;
  $('#execEstimate').textContent = task.estimate;
  $('#execBaseline').textContent = task.baseline ? `基线 ${task.baseline.slice(0, 8)}` : '未领取';

  renderActions(task);
  renderReview(task);
  watchReview();
  renderBaseline(task);
  renderSteps(task);
  renderAcceptance(task, acceptance ?? task.review?.acceptance);
  renderDeviations(task);
  renderScope(task, diff);
  renderDiff(task, diff);
}

/** Reloads diff state for the open package; no-op before it is claimed. */
async function refreshDiff() {
  if (!current?.baseline) {
    renderScope(current, null);
    renderDiff(current, null);
    return;
  }
  try {
    const diff = await call(window.taskpilot.diff.stat(current.id));
    renderScope(current, diff);
    renderDiff(current, diff);
    const out = diff.scope.outOfScope.length;
    $('#execDiffHint').textContent = out > 0
      ? `${out} 个文件超出工作包范围`
      : `相对基线 ${current.baseline.slice(0, 8)}`;
  } catch (error) {
    showToast(`读取改动失败：${describeError(error)}`);
  }
}

async function openExecution(id) {
  try {
    current = await call(window.taskpilot.getTask(id));
  } catch (error) {
    showToast(`打开工作包失败：${describeError(error)}`);
    return;
  }
  $('#execVerify').replaceChildren(emptyHint('terminal', '尚未运行验证。'));
  document.querySelectorAll('[data-verify]').forEach((button) => button.classList.remove('selected'));
  renderExecution(current);
  showView('execution');
  $('#backToQueue').focus();
  refreshDiff();
}

/** Re-reads the open package and the queue after a state change. */
async function reloadCurrent() {
  current = await call(window.taskpilot.getTask(current.id));
  renderExecution(current);
  await refreshDiff();
  await reloadQueue();
}

const VERIFY_LABELS = { test: '测试', lint: 'Lint', build: 'Build', smoke: '冒烟测试' };
const reviewModel = window.TaskPilotReviewModel;

function renderVerifyResult(kind, result) {
  const container = $('#execVerify');
  const ok = result.summary.ok;
  const summary = el('div', `verify-summary ${ok ? 'pass' : 'fail'}`);
  summary.append(withIcon('span', 'verify-verdict', ok ? 'check-circle' : 'x-circle', ok ? '通过' : '失败'));
  if (result.summary.total > 0) {
    summary.append(el('span', 'verify-counts',
      `${result.summary.passed}/${result.summary.total} 通过` +
      (result.summary.skipped ? ` · ${result.summary.skipped} 跳过` : '')));
  } else {
    summary.append(el('span', 'verify-counts', result.timedOut ? '超时' : `退出码 ${result.exitCode}`));
  }
  summary.append(withIcon('span', 'verify-duration', 'clock', `${(result.durationMs / 1000).toFixed(1)}s`));

  const nodes = [summary, withIcon('div', 'verify-command', 'terminal', `${VERIFY_LABELS[kind]} · ${result.command}`)];
  if (result.evidence) nodes.push(evidenceRow(result.evidence));
  if (result.report && !result.report.trusted) {
    nodes.push(withIcon('div', 'verify-note warn-text', 'alert', reviewModel.REASONS[`report_${result.report.problem}`] ?? result.report.problem));
  }

  const failures = result.results.filter((entry) => !entry.passed && !entry.skipped && !entry.todo);
  if (failures.length > 0) {
    const list = el('div', 'verify-failures');
    failures.forEach((entry) => list.append(withIcon('div', null, 'x', entry.fullName ?? entry.name)));
    nodes.push(list);
  }
  // The raw log is the fallback when nothing could be parsed.
  if (!ok || result.summary.total === 0) {
    nodes.push(el('pre', 'verify-output', result.output.trim() || '(无输出)'));
  }
  container.replaceChildren(...nodes);
}

async function runVerification(kind) {
  const buttons = [...document.querySelectorAll('[data-verify]')];
  const active = buttons.find((button) => button.dataset.verify === kind);
  buttons.forEach((button) => {
    button.disabled = true;
    button.classList.toggle('selected', button === active);
  });
  active.classList.add('running');
  $('#execVerify').replaceChildren(emptyHint('spinner', `正在运行 ${VERIFY_LABELS[kind]}…`));
  $('#execVerify .icon').classList.add('spin');
  try {
    const result = await call(window.taskpilot.verify.run(kind, current.id));
    renderVerifyResult(kind, result);
    if (result.acceptance) renderAcceptance(current, result.acceptance);
  } catch (error) {
    $('#execVerify').replaceChildren(emptyHint('alert', describeError(error)));
  } finally {
    active.classList.remove('running');
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function openDeviationForm() {
  // An <option> with no value attribute reports its text as the value, so the
  // placeholders set value explicitly to stay distinguishable from a choice.
  const placeholder = (text) => {
    const option = el('option', null, text);
    option.value = '';
    return option;
  };

  const stepSelect = $('#deviationStep');
  stepSelect.replaceChildren(placeholder('不指向特定指令'));
  current.steps.forEach((step, index) => {
    const option = el('option', null, `指令 ${index + 1}：${step.replace(/`/g, '')}`);
    option.value = String(index);
    stepSelect.append(option);
  });

  const fileSelect = $('#deviationFile');
  fileSelect.replaceChildren(placeholder('不指向特定文件'));
  current.fileScope.forEach((filePath) => {
    const option = el('option', null, filePath);
    option.value = filePath;
    fileSelect.append(option);
  });

  $('#deviationNote').value = '';
  lastFocused = document.activeElement;
  deviationModal.hidden = false;
  $('#deviationNote').focus();
}

function closeDeviationForm() {
  if (deviationModal.hidden) return;
  deviationModal.hidden = true;
  lastFocused?.focus();
}

async function submitDeviation() {
  const note = $('#deviationNote').value;
  if (!note.trim()) {
    showToast('请填写偏差说明。');
    $('#deviationNote').focus();
    return;
  }
  const stepValue = $('#deviationStep').value;
  const fileValue = $('#deviationFile').value;
  try {
    await call(window.taskpilot.transition(current.id, 'report_deviation', {
      deviation: {
        note,
        stepIndex: stepValue === '' ? null : Number(stepValue),
        filePath: fileValue || null,
      },
    }));
    closeDeviationForm();
    await reloadCurrent();
    showToast('偏差已记录，AI 团队会重新评估。');
  } catch (error) {
    showToast(`提交失败：${describeError(error)}`);
  }
}

const TRANSITION_TOASTS = {
  claim: '已领取，基线已记录。',
  submit_for_review: '已提交，QA 正在审查。',
  block: '已标记为阻塞。',
  unblock: '已解除阻塞。',
  release: '已放回队列。',
};

async function runTransition(name) {
  if (name === 'report_deviation') {
    openDeviationForm();
    return;
  }
  try {
    await call(window.taskpilot.transition(current.id, name));
    await reloadCurrent();
    showToast(TRANSITION_TOASTS[name] ?? '状态已更新。');
  } catch (error) {
    showToast(`操作失败：${describeError(error)}`);
  }
}

taskList.addEventListener('click', async (event) => {
  const item = event.target.closest('.task-item');
  if (item && (await confirmLeaveSettings())) openExecution(item.dataset.taskId);
});

$('#backToQueue').addEventListener('click', showQueue);
$('#reviewActions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-review]');
  if (button) runReviewAction(button.dataset.review);
});
$('#refreshDiff').addEventListener('click', refreshDiff);

$('#execActions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-transition]');
  if (button) runTransition(button.dataset.transition);
});

$('#execSteps').addEventListener('change', async (event) => {
  const box = event.target.closest('input[type="checkbox"]');
  if (!box) return;
  try {
    const state = await call(window.taskpilot.setStepDone(current.id, Number(box.dataset.stepIndex), box.checked));
    current = { ...current, completedSteps: state.completedSteps };
    renderSteps(current);
  } catch (error) {
    box.checked = !box.checked; // revert the optimistic toggle
    showToast(`保存进度失败：${describeError(error)}`);
  }
});

document.querySelectorAll('[data-verify]').forEach((button) => {
  button.addEventListener('click', () => runVerification(button.dataset.verify));
});

async function showRequirements(options) {
  if (!(await confirmLeaveSettings())) return;
  current = null;
  window.TaskPilotRequirements.open(options);
}

$('#newTaskButton').addEventListener('click', () => showRequirements({ compose: true }));
$('#requirementsNav').addEventListener('click', () => showRequirements());
$('#closeDeviation').addEventListener('click', closeDeviationForm);
$('#cancelDeviation').addEventListener('click', closeDeviationForm);
$('#submitDeviation').addEventListener('click', submitDeviation);
deviationModal.addEventListener('click', (event) => {
  if (event.target === deviationModal) closeDeviationForm();
});

/** Keeps Tab inside an open dialog. */
function trapFocus(event, container) {
  const focusable = [...container.querySelectorAll('button:not([hidden]), select, textarea, input')]
    .filter((node) => !node.disabled);
  if (focusable.length === 0) return;
  const [first] = focusable;
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

document.addEventListener('keydown', (event) => {
  if (!confirmModal.hidden) {
    if (event.key === 'Escape') settleConfirm(false);
    else if (event.key === 'Tab') trapFocus(event, confirmModal);
  } else if (!deviationModal.hidden) {
    if (event.key === 'Escape') closeDeviationForm();
    else if (event.key === 'Tab') trapFocus(event, deviationModal);
  } else if (event.key === 'Escape' && !executionView.hidden) {
    showQueue();
  } else if ((event.metaKey || event.ctrlKey) && event.key === 's' && !settingsView.hidden) {
    event.preventDefault();
    window.TaskPilotSettings.saveAll();
  } else if ((event.metaKey || event.ctrlKey) && event.key === ',') {
    event.preventDefault();
    showSettings();
  }
});

$('#queueNav').addEventListener('click', showQueue);
$('#settingsLink').addEventListener('click', () => showSettings());
$('#topAvatar').addEventListener('click', () => showSettings('profile'));
$('#workspacePicker').addEventListener('click', () => showSettings('repository'));
$('#workspacePicker').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    showSettings('repository');
  }
});

async function init() {
  renderHeading();
  try {
    applyPreferences(await call(window.taskpilot.preferences.get()));
  } catch (error) {
    console.error('Failed to load preferences', error);
    paintAvatar($('#topAvatar'), profile);
  }
  try {
    await reloadQueue();
  } catch (error) {
    console.error('Failed to load tasks', error);
    showToast(`工作包加载失败：${describeError(error)}`);
  }
  const info = await refreshWorkspaceStatus();
  if (info && !info.configured) showToast('尚未配置工作区，diff 和验证暂不可用。', 'info');
}

init();
