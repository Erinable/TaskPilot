// Pure text for evidence, baselines and review attention items. Kept out of
// renderer.js so the wording can be tested without a DOM.
(function (root) {
  const KIND_LABELS = { test: '测试', lint: 'Lint', build: 'Build', smoke: '冒烟测试' };

  const EVIDENCE_STATUS = {
    pass: { label: '通过', tone: 'done', icon: 'check-circle' },
    fail: { label: '失败', tone: 'blocked', icon: 'x-circle' },
    unverifiable: { label: '无法验证', tone: 'in_review', icon: 'alert' },
    skipped: { label: '未运行', tone: '', icon: 'circle' },
  };

  const REASONS = {
    new_failures: '有相对基线新增的失败',
    no_baseline: '没有基线可对比，失败按本次改动引入处理',
    preexisting_only: '只有基线上就失败的测试仍然失败',
    crashed: '命令异常退出，没有解析到测试结果',
    broken_at_baseline: '基线上同样异常，无法判断这次改动的影响',
    timed_out: '运行超时',
    timed_out_at_baseline: '基线上同样超时',
    report_missing: '没有生成 JUnit 报告',
    report_stale: 'JUnit 报告不是本次运行写入的',
    report_not_a_file: 'JUnit 报告不是普通文件（可能是符号链接）',
    report_outside: 'JUnit 报告指向工作区之外',
    report_too_large: 'JUnit 报告超过 5 MB',
    report_invalid: 'JUnit 报告无法解析',
    command_missing: '找不到可执行文件',
  };

  const BASELINE = {
    measuring: () => '正在基线上运行提交前检查…',
    measured: (b) => `基线已测量${failingCount(b) ? `：${failingCount(b)} 个测试在基线上就失败，不会算作这次改动引入` : '，所有检查在基线上都通过'}`,
    unavailable: (b) => ({
      dirty_tree: '领取时工作树有未提交的修改，没有测量基线。提交或还原后可以重新测量。',
      head_moved: '领取后 HEAD 已移动，没有测量基线。',
      no_checks: '没有配置提交前运行的检查，不需要基线。',
      interrupted: '基线测量被中断（应用退出）。',
      cancelled: '基线测量已取消。',
    }[b.reason] ?? `没有测量基线（${b.reason ?? '未知原因'}）。`),
    contaminated: () => '测量期间工作树发生了变化，这次基线已作废。还原改动后可以重新测量。',
  };

  function failingCount(baseline) {
    return Object.values(baseline.checks ?? {}).reduce((sum, check) => sum + (check.failing?.length ?? 0), 0);
  }

  /** One line for the execution page; `canRemeasure` drives the button. */
  function baselineText(baseline) {
    if (!baseline) return { text: '', canRemeasure: false };
    const text = (BASELINE[baseline.status] ?? (() => ''))(baseline);
    const canRemeasure = baseline.status === 'contaminated'
      || (baseline.status === 'unavailable' && baseline.reason !== 'no_checks');
    return { text, canRemeasure };
  }

  function evidenceLine(item) {
    const status = EVIDENCE_STATUS[item.status] ?? EVIDENCE_STATUS.skipped;
    const parts = [`${KIND_LABELS[item.kind] ?? item.kind} ${status.label}`];
    if (item.reason && REASONS[item.reason]) parts.push(REASONS[item.reason]);
    if (!item.blocking) parts.push('仅提示，不阻断');
    return { text: parts.join(' · '), tone: status.tone, icon: status.icon };
  }

  const CRITERION_EVIDENCE = {
    verified: '关联测试通过',
    failed: '关联测试失败',
    missing: '没有找到关联测试',
    unverifiable: '关联测试无法验证',
    manual: '无关联测试，需人工确认',
  };

  function attentionText(item, acceptance = []) {
    const criterion = (index) => `「${acceptance[index]?.text ?? `条件 ${index + 1}`}」`;
    switch (item.code) {
      case 'check_unverifiable': return `${KIND_LABELS[item.kind] ?? item.kind}无法验证：${REASONS[item.reason] ?? item.reason}`;
      case 'preexisting_failures': return `${KIND_LABELS[item.kind] ?? item.kind}有 ${item.count} 个测试在基线上就失败`;
      case 'no_baseline': return `${KIND_LABELS[item.kind] ?? item.kind}没有基线，无法区分既有失败`;
      case 'criterion_unverifiable': return `${criterion(item.index)}的关联测试无法验证，请人工确认`;
      case 'criterion_manual': return `${criterion(item.index)}没有关联测试，请人工确认`;
      case 'criterion_already_passing': return `${criterion(item.index)}的关联测试在改动前就已通过，不能证明这次改动有效`;
      default: return item.code;
    }
  }

  const api = { KIND_LABELS, EVIDENCE_STATUS, REASONS, CRITERION_EVIDENCE, baselineText, evidenceLine, attentionText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaskPilotReviewModel = api;
})(typeof window === 'undefined' ? globalThis : window);
