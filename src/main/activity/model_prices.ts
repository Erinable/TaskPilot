// Model prices from models.dev, synced only when the user asks (cost page).
// The app's one outbound request: a GET of the public price list, nothing is
// sent. Only priced entries are kept, as [input, output, cacheRead, cacheWrite]
// in dollars per million tokens:
//   exact       provider -> model -> price, for the providers TaskPilot has seen
//   firstParty  "lab/model" -> the lab's own price (models.dev canonical ids)
// A call is priced by its exact provider and model, else by the first-party
// price of a model with the same name; resellers' prices are never borrowed,
// they differ by up to 10x. A price of 0 counts as unknown.
//
// [人工决策-2026-10-13 16:52:32] 价格从 models.dev 手动同步，不自动联网；对不上时只借用模型原厂价格，不猜。
import path from 'node:path';

import type { TokenUsage } from '../../shared/ipc/activity.ts';
import { readStoredJson, writeStoredJson } from '../infrastructure/persisted_json.ts';

export const PRICES_FILENAME = 'model_prices.json';
export const PRICES_URL = 'https://models.dev/api.json';
const SYNC_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

type Price = [input: number, output: number, cacheRead: number | null, cacheWrite: number | null];
export type PriceTable = { syncedAt: string; exact: Record<string, Record<string, Price>>; firstParty: Record<string, Price> };
export type FetchFn = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const rate = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const lastSegment = (model: string) => model.toLowerCase().split('/').pop() as string;

const modelPrice = (model: Record<string, unknown>): Price | null => {
  const cost = isObject(model.cost) ? model.cost : null;
  const input = rate(cost?.input);
  const output = rate(cost?.output);
  if (!cost || !((input ?? 0) > 0 || (output ?? 0) > 0)) return null;
  return [input ?? 0, output ?? 0, rate(cost.cache_read), rate(cost.cache_write)];
};

// The compact table from models.dev's api.json; `providers` limits `exact`.
export const buildTable = (raw: unknown, providers: ReadonlySet<string>, syncedAt: string): PriceTable => {
  const table: PriceTable = { syncedAt, exact: {}, firstParty: {} };
  if (!isObject(raw)) throw Object.assign(new Error('models.dev returned an unexpected document'), { code: 'prices_invalid' });
  for (const [provider, entry] of Object.entries(raw)) {
    const models = isObject(entry) && isObject(entry.models) ? entry.models : {};
    for (const [id, model] of Object.entries(models)) {
      if (!isObject(model)) continue;
      const price = modelPrice(model);
      if (!price) continue;
      const providerKey = provider.toLowerCase();
      if (providers.has(providerKey)) (table.exact[providerKey] ??= {})[id.toLowerCase()] = price;
      const canonical = typeof model.canonical_model_id === 'string' ? model.canonical_model_id.toLowerCase() : '';
      if (canonical && canonical.split('/')[0] === providerKey) table.firstParty[canonical] = price;
    }
  }
  return table;
};

// The price for a call, or null when it cannot be priced honestly.
export const priceFor = (table: PriceTable | null, provider: string | null, model: string | null): Price | null => {
  if (!table || !model) return null;
  const exact = provider ? table.exact[provider.toLowerCase()]?.[model.toLowerCase()] : undefined;
  if (exact) return exact;
  const name = lastSegment(model);
  const matches = Object.entries(table.firstParty).filter(([canonical]) => lastSegment(canonical) === name);
  return matches.length === 1 ? matches[0][1] : null;
};

// Estimated cost in integer micro-dollars. Prices are per million tokens, so
// tokens × price is already in micro-dollars. A missing cache price falls
// back to the input price, which can only overstate.
export const estimateMicros = (price: Price, tokens: TokenUsage): number =>
  Math.round(tokens.input * price[0] + tokens.output * price[1] + tokens.cacheRead * (price[2] ?? price[0]) + tokens.cacheWrite * (price[3] ?? price[0]));

export const loadPrices = async (configDir: string): Promise<PriceTable | null> => {
  try {
    const raw = await readStoredJson(path.join(configDir, PRICES_FILENAME), 1);
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) && 'version' in raw && 'table' in raw ? raw.table : raw;
    return typeof (value as PriceTable | null)?.syncedAt === 'string' && isObject((value as PriceTable).exact) && isObject((value as PriceTable).firstParty)
      ? (value as PriceTable)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'unsupported_version') throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
};

// Downloads the list, keeps what TaskPilot can use, and saves it.
export const syncPrices = async (
  configDir: string,
  providers: ReadonlySet<string>,
  { fetchFn = fetch as unknown as FetchFn, now = () => new Date() }: { fetchFn?: FetchFn; now?: () => Date } = {},
): Promise<PriceTable> => {
  const response = await fetchFn(PRICES_URL, { signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
  if (!response.ok) throw Object.assign(new Error(`models.dev answered ${response.status}`), { code: 'prices_unavailable' });
  const text = await response.text();
  if (text.length > MAX_DOWNLOAD_BYTES) throw Object.assign(new Error('models.dev price list is unexpectedly large'), { code: 'prices_invalid' });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('models.dev returned invalid JSON'), { code: 'prices_invalid' });
  }
  const table = buildTable(raw, providers, now().toISOString());
  const file = path.join(configDir, PRICES_FILENAME);
  // Written whole, then renamed, so a crash never leaves half a table.
  await writeStoredJson(file, { version: 1, table });
  return table;
};
