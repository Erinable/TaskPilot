// Rubric judge: a separate Claude call that scores what deterministic checks
// can't. Scores are 1–5 with a one-line reason, so a regression can be traced
// to a specific criterion rather than a single opaque number.
const cli = require('../../src/agents/claude-cli');

const CRITERIA = {
  questionValue: 'Each clarifying question would change the plan depending on the answer. No questions whose answer is obvious from the requirement or the repository, and no generic checklist questions. Asking nothing is right when nothing is unclear.',
  scopeFidelity: 'The plan does what the requirement and answers ask, no more. No features, layers, or infrastructure the user did not ask for or ruled out. Defaults chosen for unanswered questions are stated.',
  packageBoundaries: 'Packages are independently reviewable units in a sensible dependency order. Not split so finely that packages are trivial, not so coarse that one does everything.',
  actionability: 'A developer could follow the steps without guessing: concrete files, functions, and behaviour, consistent with the existing repository layout and conventions.',
  acceptance: 'Acceptance criteria are checkable outcomes tied to the requirement, with test names a developer would actually write.',
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: Object.keys(CRITERIA),
  properties: Object.fromEntries(Object.keys(CRITERIA).map((key) => [key, {
    type: 'object',
    additionalProperties: false,
    required: ['score', 'reason'],
    properties: { score: { type: 'integer', minimum: 1, maximum: 5 }, reason: { type: 'string', maxLength: 300 } },
  }])),
};

const SYSTEM = [
  'You are a strict reviewer of software planning output. You grade how a planning agent broke a requirement into work packages for a human developer.',
  'Score each criterion from 1 (poor) to 5 (excellent). 3 means acceptable with clear flaws. Reserve 5 for output you would not change.',
  'Give a one-sentence reason naming the specific flaw or strength. Write reasons in English.',
].join('\n');

function prompt(testCase, run) {
  const qa = run.clarify.questions.map((q, i) => `Q${i + 1}: ${q}\nA${i + 1}: ${run.answers[i] || '(not answered)'}`).join('\n');
  return [
    '<criteria>',
    ...Object.entries(CRITERIA).map(([key, text]) => `${key}: ${text}`),
    '</criteria>',
    '',
    '<requirement>', testCase.requirement.text, '</requirement>',
    '',
    '<repository_files>', testCase.files.join('\n') || '(none)', '</repository_files>',
    '',
    '<clarifications>', qa || '(no questions asked)', '</clarifications>',
    '',
    '<plan>', JSON.stringify(run.plan, null, 2), '</plan>',
  ].join('\n');
}

async function judge(testCase, run, { model } = {}) {
  const { output, costUsd } = await cli.runStructured({ prompt: prompt(testCase, run), systemPrompt: SYSTEM, schema: SCHEMA, model, budgetUsd: 1 });
  return { scores: output, costUsd };
}

module.exports = { CRITERIA, judge };
