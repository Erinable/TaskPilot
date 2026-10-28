// Cost estimate for a lab generation and its self-check. The token model is
// deliberately kept separate from orchestration so the estimate has no side
// effects and can be reviewed independently.
import * as generator from '../agents/lab_generator.ts';
import * as verifier from '../agents/lab_verifier.ts';
import * as labVerify from './lab_verify.ts';
import { estimateMicros } from '../activity/model_prices.ts';
import type { LabEstimate } from '../../shared/ipc/requirements.ts';
import type { NextLab } from './lab_planning.ts';
type Price = Parameters<typeof estimateMicros>[0];
type Bound = 'low' | 'high';

const CHARS_PER_TOKEN = 3;
const CLI_OVERHEAD_TOKENS = 3000;
const SPEC_JSON_TOKENS = 8000;
const SPEC_OUTPUT_TOKENS = { low: 50_000, high: 120_000 };
const CODE_OUTPUT_TOKENS = { low: 45_000, high: 100_000 };
// The self-check's two calls read the whole lab back. Not yet measured by an
// eval: a guess from the generator's calls, to be calibrated with T12.
const LAB_JSON_TOKENS = 16_000;
const VERIFY_OUTPUT_TOKENS = { low: 15_000, high: 40_000 };
// low: one round that passes; high: a failed round, one repair (priced as a
// code call) and a second round, the path the CARM-33 example takes.
const VERIFY_ROUNDS = { low: 1, high: 2 };
const REPAIRS = { low: 0, high: 1 };

export const estimateLab = ({
  request,
  next,
  model,
  price,
  stuck,
}: {
  request: generator.LabRequest;
  next: NextLab;
  model: string | null;
  price: Price | null;
  stuck: { id: string; title: string }[];
}): LabEstimate => {
  const promptTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN) + CLI_OVERHEAD_TOKENS;
  const specInput = promptTokens(generator.systemPrompt() + generator.specPrompt(request));
  const verifyInput = promptTokens(verifier.mutantSystemPrompt() + verifier.consistencySystemPrompt()) + 2 * LAB_JSON_TOKENS;
  const usage = (bound: Bound) => ({
    input: 2 * specInput + SPEC_JSON_TOKENS + VERIFY_ROUNDS[bound] * verifyInput + REPAIRS[bound] * (specInput + LAB_JSON_TOKENS),
    output:
      SPEC_OUTPUT_TOKENS[bound] + CODE_OUTPUT_TOKENS[bound] + VERIFY_ROUNDS[bound] * VERIFY_OUTPUT_TOKENS[bound] + REPAIRS[bound] * CODE_OUTPUT_TOKENS[bound],
  });
  const usd = (bound: Bound) => (price ? estimateMicros(price, { ...usage(bound), cacheRead: 0, cacheWrite: 0 }) / 1_000_000 : 0);
  return {
    concepts: request.concepts.map((concept) => ({ id: concept.id, label: concept.label })),
    difficulty: request.difficulty,
    change: next.change,
    stuck: next.stuck ? { notes: stuck } : null,
    calls: 2 + 2 * VERIFY_ROUNDS.low,
    maxCalls: 2 + 2 * labVerify.MAX_ROUNDS + (labVerify.MAX_ROUNDS - 1),
    tokens: usage('high'),
    model,
    usd: price ? { low: usd('low'), high: usd('high') } : null,
  };
};
