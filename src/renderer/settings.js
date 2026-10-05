// Settings page controller: secondary nav, search, one form per page, and a
// shared save bar for unsaved edits.
//
// Loaded after renderer.js, which provides $, el, icon, call, describeError,
// showToast, showView, confirmAction, and the profile/workspace refreshers.
(function settingsPage() {
  const model = window.TaskPilotSettingsModel;
  const { PAGE_STORES } = model;

  const AVATAR_LABELS = { sunset: '日落', ocean: '海洋', violet: '紫罗兰', forest: '森林', graphite: '石墨' };
  const MAX_NAME_LENGTH = 40;
  const STATUS_IDS = { test: '#statusTest', lint: '#statusLint', build: '#statusBuild' };
  const FIELD_INPUTS = {
    root: '#settingsRoot',
    test: '#commandTest',
    lint: '#commandLint',
    build: '#commandBuild',
    displayName: '#profileName',
  };
  // Which page shows a validation error for a given field.
  const FIELD_PAGES = {
    root: 'repository', test: 'commands', lint: 'commands', build: 'commands',
    displayName: 'profile', avatarColor: 'profile', theme: 'preferences', vibrancy: 'preferences', pathSource: 'environment',
  };

  const navItems = [...document.querySelectorAll('.settings-nav-item')];
  const pages = [...document.querySelectorAll('.settings-page')];
  const commandInputs = [...document.querySelectorAll('#commandsForm [data-kind]')];
  const settingsRoot = $('#settingsRoot');
  const savebar = $('#settingsSavebar');

  let activePage = 'profile';
  // Last saved values, in form shape; the draft is read live from the inputs.
  const saved = { preferences: null, workspace: null };
  // Avatar colour and other non-input choices live here between saves.
  let draftAvatarColor = 'sunset';
  let lastEnvironment = null;

  /* Reading and writing the forms */

  function readPreferencesDraft() {
    return {
      profile: { displayName: $('#profileName').value, avatarColor: draftAvatarColor },
      appearance: {
        theme: document.querySelector('input[name="theme"]:checked')?.value ?? 'system',
        vibrancy: $('#prefVibrancy').checked,
      },
      environment: { pathSource: document.querySelector('input[name="pathSource"]:checked')?.value ?? 'inherit' },
    };
  }

  function readWorkspaceDraft() {
    const commands = {};
    for (const input of commandInputs) commands[input.dataset.kind] = input.value;
    return { root: settingsRoot.value, commands };
  }

  function fillPreferences(prefs) {
    $('#profileName').value = prefs.profile.displayName;
    draftAvatarColor = prefs.profile.avatarColor;
    for (const radio of document.querySelectorAll('input[name="theme"]')) radio.checked = radio.value === prefs.appearance.theme;
    $('#prefVibrancy').checked = prefs.appearance.vibrancy;
    for (const radio of document.querySelectorAll('input[name="pathSource"]')) {
      radio.checked = radio.value === prefs.environment.pathSource;
    }
    renderAvatarPicker();
    renderNameCount();
  }

  function fillWorkspace(form) {
    settingsRoot.value = form.root ?? '';
    for (const input of commandInputs) input.value = form.commands[input.dataset.kind] ?? '';
  }

  /* Field status messages */

  const FIELD_STATUS_ICONS = { ok: 'check-circle', warn: 'alert', error: 'x-circle' };

  function setFieldStatus(input, status, tone, message) {
    status.className = `field-status${tone ? ` ${tone}` : ''}`;
    status.replaceChildren();
    if (message) {
      if (FIELD_STATUS_ICONS[tone]) status.append(icon(FIELD_STATUS_ICONS[tone]));
      status.append(el('span', null, message));
    }
    input?.setAttribute('aria-invalid', String(tone === 'error'));
  }

  function clearWorkspaceStatus() {
    setFieldStatus(settingsRoot, $('#rootStatus'), null, '');
    for (const input of commandInputs) setFieldStatus(input, $(STATUS_IDS[input.dataset.kind]), null, '');
  }

  /** Puts a validation error beside its field and opens that field's page. */
  function showFieldError(error) {
    const field = error.field;
    const page = FIELD_PAGES[field];
    if (!page) {
      showToast(`设置无效：${describeError(error)}`);
      return;
    }
    openPage(page);
    const input = FIELD_INPUTS[field] ? $(FIELD_INPUTS[field]) : null;
    const status = field === 'root' ? $('#rootStatus')
      : STATUS_IDS[field] ? $(STATUS_IDS[field])
      : field === 'displayName' ? $('#profileNameStatus')
      : null;
    if (status) setFieldStatus(input, status, 'error', describeError(error));
    else showToast(`设置无效：${describeError(error)}`);
    input?.focus();
  }

  /* Profile page */

  function renderAvatarPicker() {
    const swatches = $('#avatarSwatches');
    swatches.replaceChildren(...Object.entries(AVATAR_LABELS).map(([color, label]) => {
      const swatch = el('button', `avatar-swatch ${color}`);
      swatch.type = 'button';
      swatch.dataset.color = color;
      swatch.setAttribute('role', 'radio');
      swatch.setAttribute('aria-checked', String(color === draftAvatarColor));
      swatch.setAttribute('aria-label', label);
      swatch.tabIndex = color === draftAvatarColor ? 0 : -1;
      return swatch;
    }));
    paintAvatar($('#profileAvatarPreview'), { displayName: $('#profileName').value, avatarColor: draftAvatarColor });
  }

  function renderNameCount() {
    const count = model.charCount($('#profileName').value);
    const counter = $('#profileNameCount');
    counter.textContent = `${count}/${MAX_NAME_LENGTH}`;
    counter.classList.toggle('over', count > MAX_NAME_LENGTH);
    const over = count > MAX_NAME_LENGTH;
    setFieldStatus($('#profileName'), $('#profileNameStatus'), over ? 'error' : null, over ? `最多 ${MAX_NAME_LENGTH} 个字符` : '');
  }

  $('#avatarSwatches').addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-color]');
    if (!swatch) return;
    draftAvatarColor = swatch.dataset.color;
    renderAvatarPicker();
    $(`#avatarSwatches [data-color="${draftAvatarColor}"]`).focus();
    updateDirty();
  });

  // Arrow keys move through the radiogroup, as for native radios.
  $('#avatarSwatches').addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const colors = Object.keys(AVATAR_LABELS);
    draftAvatarColor = colors[(colors.indexOf(draftAvatarColor) + step + colors.length) % colors.length];
    renderAvatarPicker();
    $(`#avatarSwatches [data-color="${draftAvatarColor}"]`).focus();
    updateDirty();
  });

  $('#profileName').addEventListener('input', () => {
    renderNameCount();
    paintAvatar($('#profileAvatarPreview'), { displayName: $('#profileName').value, avatarColor: draftAvatarColor });
  });

  /* Preferences page */

  $('#vibrancyRow').hidden = navigator.platform.toLowerCase().indexOf('mac') === -1;

  /* Repository page */

  function renderRepoFacts(repo) {
    const container = $('#repoFacts');
    if (!repo) {
      container.hidden = true;
      return;
    }
    const facts = el('dl', 'fact-list');
    const add = (term, value) => facts.append(el('dt', null, term), el('dd', null, value));
    add('分支', repo.branch ?? 'detached');
    add('当前提交', repo.commit.slice(0, 12));
    add('工作区状态', repo.dirty ? `${repo.changedFiles} 个文件有改动` : '干净');
    container.replaceChildren(facts);
    container.hidden = false;
  }

  function renderWorkspaceCheck(result) {
    clearWorkspaceStatus();
    if (!result.root) {
      setFieldStatus(settingsRoot, $('#rootStatus'), 'warn', '未配置仓库，diff 和验证不可用。');
      renderRepoFacts(null);
    } else {
      const message = result.normalizedFrom ? `所选目录在仓库内，已改用仓库根目录 ${result.root}` : '这是一个 git 仓库';
      setFieldStatus(settingsRoot, $('#rootStatus'), 'ok', message);
      settingsRoot.value = result.root;
      renderRepoFacts(result.repo);
    }
    for (const input of commandInputs) {
      const kind = input.dataset.kind;
      const entry = result.commands[kind];
      const status = $(STATUS_IDS[kind]);
      if (!entry.configured) setFieldStatus(input, status, null, '未配置');
      else if (entry.resolved) setFieldStatus(input, status, 'ok', entry.resolved);
      else setFieldStatus(input, status, 'warn', '在当前 PATH 中找不到这个可执行文件。可以改用绝对路径，或在「运行环境」里改为从登录 shell 读取 PATH。');
    }
  }

  async function checkWorkspace() {
    clearWorkspaceStatus();
    try {
      renderWorkspaceCheck(await call(window.taskpilot.workspace.check(readWorkspaceDraft())));
      return true;
    } catch (error) {
      showFieldError(error);
      return false;
    }
  }

  $('#pickRoot').addEventListener('click', async () => {
    try {
      const picked = await call(window.taskpilot.workspace.pickRoot());
      if (!picked) return;
      settingsRoot.value = picked;
      updateDirty();
      await checkWorkspace();
    } catch (error) {
      showToast(`无法打开目录选择器：${describeError(error)}`);
    }
  });

  /* Environment page */

  const PATH_ERROR_HINTS = {
    shell_timeout: '登录 shell 5 秒内没有响应，已退回继承的 PATH。',
    shell_no_path: '登录 shell 没有输出 PATH，已退回继承的 PATH。',
    unsupported_shell: '不支持你的登录 shell，已退回继承的 PATH。',
    no_shell: '没有找到登录 shell（SHELL 未设置），已退回继承的 PATH。',
  };

  async function renderEnvironment({ refresh = false } = {}) {
    const source = document.querySelector('input[name="pathSource"]:checked')?.value ?? 'inherit';
    const list = $('#pathList');
    list.replaceChildren(el('li', null, '读取中…'));
    try {
      const [info, inherited] = await Promise.all([
        call(window.taskpilot.environment.info({ source, refresh })),
        source === 'login-shell' ? call(window.taskpilot.environment.info({ source: 'inherit' })) : null,
      ]);
      lastEnvironment = info;
      const known = new Set(inherited?.entries ?? info.entries);
      list.replaceChildren(...info.entries.map((entry) => el('li', known.has(entry) ? null : 'added', entry)));

      $('#inheritSummary').textContent = `${info.inheritedCount} 个目录。从终端启动时与终端一致。`;
      $('#shellSummary').textContent = info.shell ? `运行 ${info.shell} 一次，读取它的 PATH 并在本次会话中缓存` : '未检测到登录 shell';

      const note = $('#pathSourceNote');
      if (info.error) {
        note.textContent = PATH_ERROR_HINTS[info.error.code] ?? `读取失败：${info.error.message}`;
        note.className = 'warn-text';
      } else {
        const added = info.entries.filter((entry) => !known.has(entry)).length;
        note.textContent = source === 'login-shell'
          ? `${info.entries.length} 个目录，其中 ${added} 个是登录 shell 新增的`
          : `${info.entries.length} 个目录`;
        note.className = '';
      }

      const facts = $('#versionFacts');
      const add = (term, value) => facts.append(el('dt', null, term), el('dd', null, value ?? '—'));
      facts.replaceChildren();
      add('TaskPilot', info.versions.app);
      add('Electron', info.versions.electron);
      add('Node.js', info.versions.node);
      add('平台', info.platform);
      add('登录 shell', info.shell);
    } catch (error) {
      list.replaceChildren(el('li', null, describeError(error)));
    }
  }

  for (const radio of document.querySelectorAll('input[name="pathSource"]')) {
    radio.addEventListener('change', () => renderEnvironment());
  }
  $('#refreshPath').addEventListener('click', () => renderEnvironment({ refresh: true }));

  /* Data page */

  async function renderData() {
    try {
      const info = await call(window.taskpilot.data.info());
      $('#dataDir').textContent = info.configDir;
      $('#dataFiles').replaceChildren(...info.files.map((file) => {
        const item = el('li');
        item.append(icon('file'), el('code', null, file));
        return item;
      }));
      const { total, claimed, deviations } = info.packages;
      $('#resetSummary').textContent =
        `清除领取状态、基线、步骤进度和偏差记录（当前 ${total} 个工作包，${claimed} 个已领取，${deviations} 条偏差）。工作区配置和偏好设置保留。`;
      $('#resetProgress').disabled = claimed === 0 && deviations === 0;
    } catch (error) {
      showToast(`读取数据信息失败：${describeError(error)}`);
    }
  }

  $('#revealData').addEventListener('click', async () => {
    try {
      await call(window.taskpilot.data.reveal());
    } catch (error) {
      showToast(`无法打开目录：${describeError(error)}`);
    }
  });

  $('#resetProgress').addEventListener('click', async () => {
    const confirmed = await confirmAction({
      title: '重置工作包进度？',
      body: '所有工作包会回到初始状态：领取记录、基线、步骤进度和偏差记录都会被删除，无法恢复。工作区配置和偏好设置不受影响。',
      accept: '重置进度',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await call(window.taskpilot.data.resetProgress());
      await reloadQueue();
      await renderData();
      showToast('工作包进度已重置。');
    } catch (error) {
      showToast(`重置失败：${describeError(error)}`);
    }
  });

  /* Unsaved changes */

  function currentDirty() {
    if (!saved.preferences || !saved.workspace) return { preferences: false, workspace: false };
    return model.dirtyStores(saved, { preferences: readPreferencesDraft(), workspace: readWorkspaceDraft() });
  }

  function hasUnsavedChanges() {
    const dirty = currentDirty();
    return dirty.preferences || dirty.workspace;
  }

  function updateDirty() {
    const dirty = currentDirty();
    const any = dirty.preferences || dirty.workspace;
    savebar.hidden = !any;
    // Checking only means something for workspace edits.
    $('#checkSettings').hidden = !dirty.workspace;
    const labels = [];
    if (dirty.preferences) labels.push('个人与偏好');
    if (dirty.workspace) labels.push('工作区');
    $('#savebarText').textContent = any ? `${labels.join('、')}有未保存的修改` : '';
    // Mark exactly the nav entries whose page holds an edit.
    const pagesDirty = saved.preferences && saved.workspace
      ? model.dirtyPages(saved, { preferences: readPreferencesDraft(), workspace: readWorkspaceDraft() })
      : {};
    for (const item of navItems) item.classList.toggle('dirty', pagesDirty[item.dataset.page] === true);
  }

  async function saveAll() {
    const dirty = currentDirty();
    const buttons = [$('#saveSettings'), $('#checkSettings'), $('#discardSettings')];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      if (dirty.workspace) {
        // check first, so a failure is shown beside its field before anything is written
        if (!(await checkWorkspace())) return false;
        const form = await call(window.taskpilot.workspace.set(readWorkspaceDraft()));
        saved.workspace = { root: form.root ?? '', commands: { ...form.lines } };
        fillWorkspace(saved.workspace);
        await refreshWorkspaceStatus();
        renderNavWorkspace();
      }
      if (dirty.preferences) {
        const prefs = await call(window.taskpilot.preferences.set(readPreferencesDraft()));
        saved.preferences = prefs;
        fillPreferences(prefs);
        applyPreferences(prefs);
        if (activePage === 'environment') await renderEnvironment();
      }
      showToast('设置已保存。');
      return true;
    } catch (error) {
      showFieldError(error);
      return false;
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
      updateDirty();
    }
  }

  function discardAll() {
    fillPreferences(saved.preferences);
    fillWorkspace(saved.workspace);
    clearWorkspaceStatus();
    renderRepoFacts(null);
    if (activePage === 'environment') renderEnvironment();
    updateDirty();
  }

  $('#saveSettings').addEventListener('click', saveAll);
  $('#discardSettings').addEventListener('click', discardAll);
  $('#checkSettings').addEventListener('click', checkWorkspace);

  // Any edit in any settings form updates the save bar.
  for (const form of pages) {
    form.addEventListener('input', updateDirty);
    form.addEventListener('change', updateDirty);
    // Enter in a text field saves rather than reloading the page.
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveAll();
    });
  }

  /* Navigation and search */

  function renderNavWorkspace() {
    const root = saved.workspace?.root;
    $('#navWorkspaceName').textContent = root ? root.split(/[\\/]/).filter(Boolean).pop() : '工作区';
  }

  function openPage(page) {
    if (!PAGE_STORES.hasOwnProperty(page)) return;
    activePage = page;
    for (const item of navItems) {
      const active = item.dataset.page === page;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    for (const section of pages) section.hidden = section.dataset.page !== page;
    if (page === 'environment') renderEnvironment();
    if (page === 'data') renderData();
  }

  $('#settingsNav').addEventListener('click', (event) => {
    const item = event.target.closest('.settings-nav-item');
    if (item) openPage(item.dataset.page);
  });

  $('#settingsSearch').addEventListener('input', (event) => {
    const entries = navItems.map((item) => ({ page: item.dataset.page, label: item.textContent, keywords: item.dataset.keywords }));
    const visible = new Set(model.matchPages(entries, event.target.value));
    for (const item of navItems) item.hidden = !visible.has(item.dataset.page);
    // Hide a group label when none of its pages match.
    for (const label of document.querySelectorAll('.settings-group-label')) {
      let next = label.nextElementSibling;
      let anyVisible = false;
      while (next && next.classList.contains('settings-nav-item')) {
        if (!next.hidden) anyVisible = true;
        next = next.nextElementSibling;
      }
      label.hidden = !anyVisible;
    }
    $('#settingsSearchEmpty').hidden = visible.size > 0;
    // Keep the open page in sync with what the nav shows.
    if (visible.size > 0 && !visible.has(activePage)) openPage([...visible][0]);
  });

  async function load() {
    try {
      const [prefs, form] = await Promise.all([
        call(window.taskpilot.preferences.get()),
        call(window.taskpilot.workspace.get()),
      ]);
      saved.preferences = prefs;
      saved.workspace = { root: form.root ?? '', commands: { ...form.lines } };
      fillPreferences(prefs);
      fillWorkspace(saved.workspace);
      clearWorkspaceStatus();
      renderRepoFacts(null);
      renderNavWorkspace();
      paintAvatar($('#navAvatar'), prefs.profile);
      updateDirty();
    } catch (error) {
      showToast(`读取设置失败：${describeError(error)}`);
    }
  }

  /** Opens settings, reloading from disk unless there are pending edits. */
  async function open(page = activePage) {
    showView('settings');
    if (!hasUnsavedChanges()) await load();
    openPage(page);
    navItems.find((item) => item.dataset.page === page)?.focus();
  }

  window.TaskPilotSettings = { open, hasUnsavedChanges, saveAll, discardAll };
})();
