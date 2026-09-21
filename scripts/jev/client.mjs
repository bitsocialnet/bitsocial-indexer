// Development-only client. Never import this module into application code.
import { resolveJevSettings, JevConfigError } from './config.mjs';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const INPUT_USD_PER_MILLION = 0.042;
// Per-value half-cent rounding slack, not a tolerance for the combined weighted sum.
// A live synthetic response is consistent with independently rounded Score/probabilities.
export const SCORE_ROUNDING_TOLERANCE = 0.005 + 1e-9;

export class JevError extends Error {
  constructor(code) {
    super(code);
    this.name = 'JevError';
    this.code = code;
  }
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code) => {
  throw new JevError(code);
};
const probability = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const criterion = (value) => typeof value === 'string' && value.length <= 2000;

export function validateQuestions(questions) {
  if (!object(questions) || Object.keys(questions).length < 1 || Object.keys(questions).length > 20) fail('invalid_questions');
  for (const [id, question] of Object.entries(questions)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(id) ||
      !object(question) ||
      !['choice', 'noul', 'score'].includes(question.type) ||
      typeof question.instructions !== 'string' ||
      question.instructions.length > 4000
    )
      fail('invalid_questions');
    if (question.type === 'noul') {
      if (
        Object.hasOwn(question, 'criteria') &&
        (!object(question.criteria) || Object.entries(question.criteria).some(([key, value]) => !['true', 'false'].includes(key) || !criterion(value)))
      )
        fail('invalid_questions');
      continue;
    }
    if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10 || Array.from(question.criteria).some((value) => !criterion(value)))
        fail('invalid_questions');
      continue;
    }
    if (!object(question.criteria)) fail('invalid_questions');
    const choices = Object.keys(question.criteria);
    if (
      choices.length < 2 ||
      choices.length > 50 ||
      choices.some((key) => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || !criterion(question.criteria[key]))
    )
      fail('invalid_questions');
  }
}

function distribution(answer, keys) {
  if (
    !probability(answer.confidence) ||
    !object(answer.probabilities) ||
    Object.keys(answer.probabilities).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(answer.probabilities, key) || !probability(answer.probabilities[key]))
  )
    fail('invalid_response');
  const values = keys.map((key) => answer.probabilities[key]);
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.001) fail('invalid_response');
  return values;
}

export function scoreMatchesProbabilities(score, probabilities) {
  if (!Array.isArray(probabilities) || probabilities.length < 2 || probabilities.length > 10) return false;
  const values = Array.from(probabilities);
  if (values.some((value) => !probability(value)) || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > values.length - 1) return false;
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.001) return false;
  // The observed response is consistent with independently rounded two-decimal
  // values. Only those get intervals; more precise values remain exact.
  // Require a feasible underlying distribution summing to one, without changing
  // any returned value or treating arbitrary score differences as acceptable.
  const slack = (value) => Math.abs(value * 100 - Math.round(value * 100)) <= 1e-9 ? SCORE_ROUNDING_TOLERANCE : 0;
  const lower = values.map((value) => Math.max(0, value - slack(value)));
  const upper = values.map((value) => Math.min(1, value + slack(value)));
  const remaining = 1 - lower.reduce((sum, value) => sum + value, 0);
  if (remaining < -1e-9 || upper.reduce((sum, value) => sum + value, 0) < 1 - 1e-9) return false;
  const extremum = (descending) => {
    let mass = Math.max(0, remaining);
    let weighted = lower.reduce((sum, value, index) => sum + index * value, 0);
    for (let position = 0; position < values.length; position++) {
      const index = descending ? values.length - 1 - position : position;
      const added = Math.min(mass, upper[index] - lower[index]);
      weighted += index * added;
      mass -= added;
    }
    return weighted;
  };
  return score + slack(score) >= extremum(false) - 1e-9 && score - slack(score) <= extremum(true) + 1e-9;
}

export function validateResponse(data, questions, model) {
  if (!object(data) || data.model !== model || !object(data.answers) || Object.keys(data.answers).length !== Object.keys(questions).length) fail('invalid_response');
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = data.answers[id];
    if (!Object.hasOwn(data.answers, id) || !object(answer) || answer.type !== question.type) fail('invalid_response');
    if (question.type === 'noul') {
      if (!probability(answer.noul)) fail('invalid_response');
      answers[id] = { noul: answer.noul };
      continue;
    }
    if (question.type === 'score') {
      const levels = question.criteria.map((_, index) => String(index));
      const values = distribution(answer, levels);
      if (
        typeof answer.score !== 'number' ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > levels.length - 1 ||
        !object(answer.legend) ||
        Object.keys(answer.legend).length !== levels.length ||
        levels.some((level) => !Object.hasOwn(answer.legend, level) || answer.legend[level] !== question.criteria[Number(level)]) ||
        !scoreMatchesProbabilities(answer.score, values)
      )
        fail('invalid_response');
      answers[id] = {
        score: answer.score,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(levels.map((level) => [level, answer.probabilities[level]])),
        legend: Object.fromEntries(levels.map((level) => [level, answer.legend[level]])),
      };
      continue;
    }
    if (question.type !== 'choice') fail('invalid_response');
    const choices = Object.keys(question.criteria);
    const values = distribution(answer, choices);
    if (!choices.includes(answer.choice) || answer.probabilities[answer.choice] < Math.max(...values)) fail('invalid_response');
    answers[id] = {
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: Object.fromEntries(choices.map((choice) => [choice, answer.probabilities[choice]])),
    };
  }
  const usage = {};
  for (const field of ['input_tokens', 'output_tokens']) {
    const value = data.usage?.[field];
    if (Number.isSafeInteger(value) && value >= 0) usage[field] = value;
  }
  return { model, answers, usage };
}

async function readBoundedJson(response) {
  if (!response.body) fail('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256_000) fail('response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createJevClient({
  live = false,
  apiKey,
  model,
  maxRequests = 20,
  maxCalls = maxRequests,
  maxInputBytes = 60_000,
  maxInputTokens = 300_000,
  maxCostUsd = 0.02,
  timeoutMs = 8000,
  deadlineMs = 120_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (
    ![maxCalls, maxInputBytes, maxInputTokens, timeoutMs, deadlineMs].every((n) => Number.isSafeInteger(n) && n > 0) ||
    maxCalls > 1000 ||
    maxInputBytes > 128_000 ||
    timeoutMs > 30_000 ||
    deadlineMs > 600_000 ||
    !Number.isFinite(maxCostUsd) ||
    maxCostUsd <= 0 ||
    maxCostUsd > 10
  )
    fail('invalid_limits');
  const started = Date.now();
  let ready = false;
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, usageMissing: 0, reservedInputTokens: 0 };
  function stats() {
    const knownCostSubtotalUsd = (totals.inputTokens * INPUT_USD_PER_MILLION) / 1e6;
    return {
      ...totals,
      knownCostSubtotalUsd,
      estimatedCostUsd: totals.usageMissing ? null : knownCostSubtotalUsd,
      reservedMaxCostUsd: (totals.reservedInputTokens * INPUT_USD_PER_MILLION) / 1e6,
      priceUsdPerMillionInputTokens: INPUT_USD_PER_MILLION,
    };
  }
  function assertReady() {
    if (!live) fail('live_not_enabled');
    if (!ready) {
      try {
        ({ apiKey, model } = resolveJevSettings({ apiKey, model }));
      } catch (error) {
        if (error instanceof JevConfigError) fail(error.code);
        throw error;
      }
      ready = true;
    }
    return { model };
  }
  async function ask({ state, questions }) {
    assertReady();
    const token = apiKey.trim();
    validateQuestions(questions);
    let body;
    try {
      body = JSON.stringify({ model, state, questions });
    } catch {
      fail('invalid_state');
    }
    if (body.includes(token)) fail('secret_in_input');
    const bytes = Buffer.byteLength(body);
    if (bytes > maxInputBytes) fail('input_too_large');
    // Reserve one token per UTF-8 byte plus framing, including failed calls. This is deliberately
    // conservative, not a billing guarantee; actual usage remains separate and may be unavailable.
    const reserved = bytes + 1024;
    if (
      totals.requests >= maxCalls ||
      totals.reservedInputTokens + reserved > maxInputTokens ||
      ((totals.reservedInputTokens + reserved) * INPUT_USD_PER_MILLION) / 1e6 > maxCostUsd
    )
      fail('budget_exhausted');
    const remaining = deadlineMs - (Date.now() - started);
    if (remaining <= 0) fail('deadline_exceeded');
    totals.requests++;
    totals.usageMissing++;
    totals.reservedInputTokens += reserved;
    const before = Date.now();
    try {
      const response = await fetchImpl(JEV_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      });
      if (!response.ok) fail(response.status === 429 ? 'provider_throttled' : `provider_http_${response.status}`);
      const result = validateResponse(await readBoundedJson(response), questions, model);
      if (result.usage.input_tokens !== undefined) {
        totals.inputTokens += result.usage.input_tokens;
        totals.usageMissing--;
      }
      totals.outputTokens += result.usage.output_tokens || 0;
      return { ...result, latencyMs: Date.now() - before };
    } catch (error) {
      if (error instanceof JevError) throw error;
      fail(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'provider_timeout' : 'provider_unavailable');
    }
  }
  return { ask, stats, assertReady };
}
