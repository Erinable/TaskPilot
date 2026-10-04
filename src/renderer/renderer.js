// All task content is inserted with DOM APIs / textContent, never innerHTML:
// work package text is authored by AI agents and must never become markup.
const PRIORITY_LABELS = { high: '高优先级', medium: '中优先级', low: '低优先级' };

// Human-triggerable transitions, in the order they should appear.
const ACTIONS = [
  { name: 'claim', label: '开始执行', primary: true },
  { name: 'submit_for_review', label: '提交审查', primary: true },
  { name: 'unblock', label: '解除阻塞', primary: true },
  { name: 'report_deviation', label: '报告偏差' },
  { name: 'block', label: '标记阻塞' },
  { name: 'release', label: '放回队列' },
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
};

const $ = (selector) => document.querySelector(selector);
const taskList = $('#taskList');
const queueView = $('#queueView');
const executionView = $('#executionView');
const settingsView = $('#settingsView');
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

function showToast(message) {
  toastText.textContent = message;
  toast.classList.add('show');
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

  const state = el('div', 'task-state', task.icon);
  state.setAttribute('aria-hidden', 'true');

  const main = el('div', 'task-main');
  const tags = el('div', 'task-tags');
  tags.append(el('span', `scope-tag ${task.status === 'in_progress' ? 'touched' : 'untouched'}`, task.statusLabel));
  task.tags.forEach((tag) => tags.append(el('span', 'tag', tag)));
  main.append(el('div', 'task-title', task.title), el('div', 'task-description', task.description), tags);

  const side = el('div', 'task-side');
  const priority = el('span', 'priority');
  priority.append(el('i', `priority-dot ${task.priority}`), PRIORITY_LABELS[task.priority]);
  side.append(priority, el('span', 'task-time', task.estimate));

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

const VIEWS = { queue: queueView, execution: executionView, settings: settingsView };

/** Shows exactly one top-level view and syncs the sidebar highlight. */
function showView(name) {
  for (const [key, view] of Object.entries(VIEWS)) view.hidden = key !== name;
  $('#queueNav').classList.toggle('active', name === 'queue' || name === 'execution');
  $('#settingsLink').classList.toggle('active', name === 'settings');
}

function showQueue() {
  current = null;
  showView('queue');
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

const settingsRoot = $('#settingsRoot');
const commandInputs = [...document.querySelectorAll('#settingsForm [data-kind]')];
const STATUS_IDS = { test: '#statusTest', lint: '#statusLint', build: '#statusBuild' };

function readSettingsForm() {
  const commands = {};
  for (const input of commandInputs) commands[input.dataset.kind] = input.value;
  return { root: settingsRoot.value, commands };
}

function setFieldStatus(input, status, tone, message) {
  status.className = `field-status${tone ? ` ${tone}` : ''}`;
  status.textContent = message ?? '';
  input.setAttribute('aria-invalid', String(tone === 'error'));
}

function clearSettingsStatus() {
  setFieldStatus(settingsRoot, $('#rootStatus'), null, '');
  for (const input of commandInputs) setFieldStatus(input, $(STATUS_IDS[input.dataset.kind]), null, '');
}

/** Shows a validation failure next to the field it belongs to. */
function showSettingsError(error) {
  const kind = error.field;
  if (kind === 'root') {
    setFieldStatus(settingsRoot, $('#rootStatus'), 'error', describeError(error));
    settingsRoot.focus();
  } else if (STATUS_IDS[kind]) {
    const input = commandInputs.find((candidate) => candidate.dataset.kind === kind);
    setFieldStatus(input, $(STATUS_IDS[kind]), 'error', describeError(error));
    input.focus();
  } else {
    showToast(`设置无效：${describeError(error)}`);
  }
}

function renderSettingsCheck(result) {
  clearSettingsStatus();
  if (!result.root) {
    setFieldStatus(settingsRoot, $('#rootStatus'), 'warn', '未配置仓库，diff 和验证不可用。');
  } else {
    const { branch, commit, dirty, changedFiles } = result.repo;
    let message = `✓ ${branch ?? 'detached'} · ${commit.slice(0, 8)} · ${dirty ? `${changedFiles} 个文件有改动` : '工作区干净'}`;
    if (result.normalizedFrom) message += `。所选目录在仓库内，已改用仓库根目录 ${result.root}`;
    setFieldStatus(settingsRoot, $('#rootStatus'), 'ok', message);
    settingsRoot.value = result.root;
  }
  for (const input of commandInputs) {
    const kind = input.dataset.kind;
    const entry = result.commands[kind];
    const status = $(STATUS_IDS[kind]);
    if (!entry.configured) setFieldStatus(input, status, null, '未配置');
    else if (entry.resolved) setFieldStatus(input, status, 'ok', `✓ ${entry.resolved}`);
    // A PATH miss is a warning, not an error: the app's PATH can differ from
    // the user's shell (see the note on the page).
    else setFieldStatus(input, status, 'warn', '在 PATH 中找不到这个可执行文件，运行时可能失败。可以改用绝对路径。');
  }
}

async function loadSettings() {
  clearSettingsStatus();
  try {
    const form = await call(window.taskpilot.workspace.get());
    settingsRoot.value = form.root ?? '';
    for (const input of commandInputs) input.value = form.lines[input.dataset.kind] ?? '';
  } catch (error) {
    showToast(`读取设置失败：${describeError(error)}`);
  }
}

async function showSettings() {
  current = null;
  showView('settings');
  await loadSettings();
  settingsRoot.focus();
}

/** Runs `action` with the settings buttons disabled to block double submits. */
async function withSettingsBusy(action) {
  const buttons = [$('#checkSettings'), $('#saveSettings'), $('#pickRoot')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await action();
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function checkSettings() {
  await withSettingsBusy(async () => {
    clearSettingsStatus();
    try {
      renderSettingsCheck(await call(window.taskpilot.workspace.check(readSettingsForm())));
    } catch (error) {
      showSettingsError(error);
    }
  });
}

async function saveSettings() {
  await withSettingsBusy(async () => {
    clearSettingsStatus();
    try {
      const form = readSettingsForm();
      const check = await call(window.taskpilot.workspace.check(form));
      await call(window.taskpilot.workspace.set(form));
      renderSettingsCheck(check);
      await refreshWorkspaceStatus();
      showToast('设置已保存。');
    } catch (error) {
      showSettingsError(error);
    }
  });
}

async function pickRoot() {
  try {
    const picked = await call(window.taskpilot.workspace.pickRoot());
    if (!picked) return;
    settingsRoot.value = picked;
    await checkSettings();
  } catch (error) {
    showToast(`无法打开目录选择器：${describeError(error)}`);
  }
}

function renderSteps(task) {
  const done = new Set(task.completedSteps);
  const claimed = task.status === 'in_progress';
  $('#execStepProgress').textContent = `${done.size} / ${task.steps.length} 已完成`;

  $('#execSteps').replaceChildren(...task.steps.map((step, index) => {
    const item = el('li', `step-item${done.has(index) ? ' done' : ''}`);
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = done.has(index);
    box.disabled = !claimed; // progress only makes sense while executing
    box.dataset.stepIndex = String(index);
    const text = el('span');
    appendInlineCode(text, step);
    label.append(box, text);
    item.append(label);
    return item;
  }));
}

/** Acceptance rows; `matched` comes from the last verification run, if any. */
function renderAcceptance(task, matched) {
  const byText = new Map((matched ?? []).map((entry) => [entry.text, entry]));
  $('#execAcceptance').replaceChildren(...task.acceptance.map((criterion) => {
    const result = byText.get(criterion.text);
    const verified = result?.verified === true;
    const failed = result !== undefined && !result.manual && !verified && !result.missing;
    const row = el('div', `criterion${verified ? ' verified' : failed ? ' failed' : ''}`);
    row.append(el('span', 'criterion-mark', verified ? '✓' : failed ? '✕' : '○'));

    const body = el('div');
    body.append(el('span', 'criterion-text', criterion.text));
    if (criterion.test) {
      const note = verified ? '已通过' : failed ? '未通过' : result?.missing ? '未找到该测试' : '待验证';
      body.append(el('span', 'criterion-test', `${criterion.test} · ${note}`));
    } else {
      body.append(el('span', 'criterion-test', '需人工确认'));
    }
    row.append(body);
    return row;
  }));
}

function renderDeviations(task) {
  const panel = $('#deviationPanel');
  panel.hidden = task.deviations.length === 0;
  $('#execDeviations').replaceChildren(...task.deviations.map((deviation) => {
    const item = el('div', 'deviation-item');
    const note = el('p');
    appendInlineCode(note, deviation.note);
    item.append(note);
    const parts = [new Date(deviation.reportedAt).toLocaleString('zh-CN')];
    if (deviation.stepIndex !== null) parts.push(`指令 ${deviation.stepIndex + 1}`);
    if (deviation.filePath) parts.push(deviation.filePath);
    item.append(el('small', null, parts.join(' · ')));
    return item;
  }));
}

function scopeRow(filePath, kind, churn) {
  const labels = { touched: '已改动', untouched: '未改动', out: '超出范围' };
  const row = el('div', 'scope-row');
  row.append(el('span', `scope-tag ${kind}`, labels[kind]), el('span', 'scope-path', filePath));
  if (churn) {
    const stat = el('span', 'scope-churn');
    stat.append(el('span', 'added', `+${churn.added}`), ' ', el('span', 'removed', `-${churn.removed}`));
    row.append(stat);
  }
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
    container.replaceChildren(el('p', 'empty-hint', '领取工作包后可查看改动。'));
    return;
  }
  if (changes.length === 0) {
    container.replaceChildren(el('p', 'empty-hint', '相对基线还没有改动。'));
    return;
  }

  container.replaceChildren(...changes.map((change) => {
    const file = el('div', 'diff-file');
    const header = el('button', 'diff-file-header');
    header.type = 'button';
    const chevron = el('span', 'diff-chevron', '⌄');
    chevron.setAttribute('aria-hidden', 'true');
    header.append(chevron, el('span', 'scope-path', change.path));
    if (!change.binary) {
      const stat = el('span', 'scope-churn');
      stat.append(el('span', 'added', `+${change.added}`), ' ', el('span', 'removed', `-${change.removed}`));
      header.append(stat);
    }

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
    const button = el('button', action.primary ? 'primary-button' : 'secondary-button', action.label);
    button.dataset.transition = action.name;
    return button;
  });
  $('#execActions').replaceChildren(...buttons);

  const notice = $('#execNotice');
  if (buttons.length === 0) {
    notice.hidden = false;
    notice.textContent = `当前状态「${task.statusLabel}」由 AI 团队推进，你无需操作。`;
  } else {
    notice.hidden = true;
  }
}

function renderExecution(task, { diff, acceptance } = {}) {
  $('#execTitle').textContent = task.title;
  $('#execIntro').textContent = task.intro;
  const badge = $('#execStatus');
  badge.className = `status-badge ${task.status}`;
  badge.textContent = task.statusLabel;
  $('#execPriorityDot').className = `priority-dot ${task.priority}`;
  $('#execPriority').textContent = PRIORITY_LABELS[task.priority];
  $('#execModule').textContent = `${task.module} 模块`;
  $('#execEstimate').textContent = task.estimate;
  $('#execBaseline').textContent = task.baseline ? `基线 ${task.baseline.slice(0, 8)}` : '未领取';

  renderActions(task);
  renderSteps(task);
  renderAcceptance(task, acceptance);
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
  $('#execVerify').replaceChildren(el('p', 'empty-hint', '尚未运行验证。'));
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
  tasks = await call(window.taskpilot.listTasks());
  renderTasks();
}

const VERIFY_LABELS = { test: '测试', lint: 'Lint', build: 'Build' };

function renderVerifyResult(kind, result) {
  const container = $('#execVerify');
  const summary = el('div', 'verify-summary');
  const ok = result.summary.ok;
  summary.append(el('span', `verify-verdict ${ok ? 'pass' : 'fail'}`, ok ? '通过' : '失败'));
  if (result.summary.total > 0) {
    summary.append(el('span', 'verify-counts',
      `${result.summary.passed}/${result.summary.total} 通过` +
      (result.summary.skipped ? ` · ${result.summary.skipped} 跳过` : '')));
  } else {
    summary.append(el('span', 'verify-counts', result.timedOut ? '超时' : `退出码 ${result.exitCode}`));
  }
  summary.append(el('span', 'verify-duration', `${(result.durationMs / 1000).toFixed(1)}s`));

  const nodes = [summary, el('div', 'verify-command', `${VERIFY_LABELS[kind]} · ${result.command}`)];

  const failures = result.results.filter((entry) => !entry.passed && !entry.skipped && !entry.todo);
  if (failures.length > 0) {
    const list = el('div', 'verify-failures');
    failures.forEach((entry) => list.append(el('div', null, `✕ ${entry.name}`)));
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
  buttons.forEach((button) => { button.disabled = true; });
  $('#execVerify').replaceChildren(el('p', 'empty-hint', `正在运行 ${VERIFY_LABELS[kind]}…`));
  try {
    const result = await call(window.taskpilot.verify.run(kind, current.id));
    renderVerifyResult(kind, result);
    if (result.acceptance) renderAcceptance(current, result.acceptance);
  } catch (error) {
    $('#execVerify').replaceChildren(el('p', 'empty-hint', describeError(error)));
  } finally {
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
  submit_for_review: '已提交审查。',
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

taskList.addEventListener('click', (event) => {
  const item = event.target.closest('.task-item');
  if (item) openExecution(item.dataset.taskId);
});

$('#backToQueue').addEventListener('click', showQueue);
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

$('#newTaskButton').addEventListener('click', () => showToast('需求创建向导即将上线。'));
$('#closeDeviation').addEventListener('click', closeDeviationForm);
$('#cancelDeviation').addEventListener('click', closeDeviationForm);
$('#submitDeviation').addEventListener('click', submitDeviation);
deviationModal.addEventListener('click', (event) => {
  if (event.target === deviationModal) closeDeviationForm();
});

document.addEventListener('keydown', (event) => {
  if (!deviationModal.hidden) {
    if (event.key === 'Escape') closeDeviationForm();
    else if (event.key === 'Tab') {
      const focusable = [...deviationModal.querySelectorAll('button, select, textarea')];
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
  } else if (event.key === 'Escape' && !executionView.hidden) {
    showQueue();
  }
});

$('#queueNav').addEventListener('click', showQueue);
$('#settingsLink').addEventListener('click', showSettings);
$('#workspacePicker').addEventListener('click', showSettings);
$('#workspacePicker').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    showSettings();
  }
});
$('#settingsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  saveSettings();
});
$('#checkSettings').addEventListener('click', checkSettings);
$('#pickRoot').addEventListener('click', pickRoot);

async function init() {
  renderHeading();
  try {
    tasks = await call(window.taskpilot.listTasks());
    renderTasks();
  } catch (error) {
    console.error('Failed to load tasks', error);
    showToast(`工作包加载失败：${describeError(error)}`);
  }
  const info = await refreshWorkspaceStatus();
  if (info && !info.configured) showToast('尚未配置工作区，diff 和验证暂不可用。');
}

init();
