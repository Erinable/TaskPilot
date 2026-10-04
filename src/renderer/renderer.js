// All task content is inserted with DOM APIs / textContent, never innerHTML,
// so data from future integrations can't inject markup.
const PRIORITY_LABELS = { high: '高优先级', medium: '中优先级', low: '低优先级' };

const $ = (selector) => document.querySelector(selector);
const taskList = $('#taskList');
const modal = $('#taskModal');
const toast = $('#toast');
const toastText = $('#toastText');

let tasks = [];
let lastFocused = null;
let toastTimer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
  $('#queueCount').textContent = tasks.length;
  $('#pendingCount').textContent = tasks.length;
}

function renderHeading(now = new Date()) {
  const hour = now.getHours();
  $('#greeting').textContent = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  $('#todayLabel').textContent = now
    .toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    .toUpperCase();
}

function fillModal(task) {
  $('#modalTitle').textContent = task.title;
  $('#modalIntro').textContent = task.intro;
  $('#modalPriorityDot').className = `priority-dot ${task.priority}`;
  $('#modalPriority').textContent = PRIORITY_LABELS[task.priority];
  $('#modalModule').textContent = `${task.module} 模块`;
  $('#modalEstimate').textContent = task.estimate;

  $('#modalSteps').replaceChildren(...task.steps.map((step) => {
    const li = el('li');
    appendInlineCode(li, step);
    return li;
  }));

  $('#modalAcceptance').replaceChildren(...task.acceptance.map((criterion) => {
    const row = el('div', 'acceptance-row');
    const check = el('span', null, '✓');
    check.setAttribute('aria-hidden', 'true');
    row.append(check, el('span', null, criterion));
    return row;
  }));
}

function focusableInModal() {
  return [...modal.querySelectorAll('button:not([disabled])')];
}

function openModal(task) {
  fillModal(task);
  lastFocused = document.activeElement;
  modal.hidden = false;
  $('#startTaskButton').focus();
}

function closeModal() {
  if (modal.hidden) return;
  modal.hidden = true;
  lastFocused?.focus();
}

function showToast(message) {
  toastText.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2800);
}

function trapFocus(event) {
  const focusable = focusableInModal();
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

taskList.addEventListener('click', (event) => {
  const item = event.target.closest('.task-item');
  const task = item && tasks.find((candidate) => candidate.id === item.dataset.taskId);
  if (task) openModal(task);
});
$('#newTaskButton').addEventListener('click', () => showToast('需求创建向导即将上线'));
$('#closeModal').addEventListener('click', closeModal);
modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
$('#startTaskButton').addEventListener('click', () => { closeModal(); showToast('工作包已加入执行中'); });
$('#deviationButton').addEventListener('click', () => { closeModal(); showToast('偏差反馈已记录，AI 团队会重新评估'); });
document.addEventListener('keydown', (event) => {
  if (modal.hidden) return;
  if (event.key === 'Escape') closeModal();
  else if (event.key === 'Tab') trapFocus(event);
});

async function init() {
  renderHeading();
  try {
    tasks = await window.taskpilot.listTasks();
    renderTasks();
  } catch (error) {
    console.error('Failed to load tasks', error);
    showToast('工作包加载失败');
  }
}

init();
