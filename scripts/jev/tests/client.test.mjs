import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevClient, validateQuestions, validateResponse, JEV_ENDPOINT, SCORE_ROUNDING_TOLERANCE, scoreMatchesProbabilities } from '../client.mjs';

const model = 'jev-1.13.0';
const questions = { decision: { type: 'choice', instructions: 'Assess', criteria: { yes: 'Yes', no: 'No' } } };
const response = () => ({
  model,
  answers: { decision: { type: 'choice', choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } } },
  usage: { input_tokens: 100, output_tokens: 5 },
});
const options = (extra = {}) => ({ live: true, apiKey: 'fixture-key', model, fetchImpl: async () => Response.json(response()), ...extra });
const mixedQuestions = {
  ...questions,
  supported: { type: 'noul', instructions: 'Is this supported by the evidence?' },
  sufficient: { type: 'noul', instructions: 'Is the evidence sufficient?', criteria: { true: 'Enough evidence', false: 'Missing evidence' } },
  relevance: { type: 'score', instructions: 'Rate relevance to the query.', criteria: ['Unrelated', 'Related topic', 'Direct answer'] },
};
const mixedResponse = () => ({
  ...response(),
  answers: {
    ...response().answers,
    supported: { type: 'noul', noul: 0.95 },
    sufficient: { type: 'noul', noul: 0.6 },
    relevance: { type: 'score', score: 1.2, confidence: 0.4, probabilities: { 0: 0.2, 1: 0.4, 2: 0.4 }, legend: { 0: 'Unrelated', 1: 'Related topic', 2: 'Direct answer' } },
  },
});

test('mixed primitives use one request and retain the exact Choice normalization contract', async () => {
  let calls = 0;
  const client = createJevClient(options({ fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, JEV_ENDPOINT);
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body).questions, mixedQuestions);
    const data = mixedResponse();
    data.answers.supported.confidence = 'not-a-noul-field';
    data.answers.relevance.providerExtra = 'do-not-return';
    return Response.json(data);
  } }));
  const result = await client.ask({ state: 'fixture evidence', questions: mixedQuestions });
  assert.deepEqual(result.answers, {
    decision: { choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } },
    supported: { noul: 0.95 },
    sufficient: { noul: 0.6 },
    relevance: { score: 1.2, confidence: 0.4, probabilities: { 0: 0.2, 1: 0.4, 2: 0.4 }, legend: { 0: 'Unrelated', 1: 'Related topic', 2: 'Direct answer' } },
  });
  assert.equal(calls, 1);
  assert.equal(client.stats().requests, 1);
  assert.equal(client.stats().inputTokens, 100);
  assert.equal(client.stats().usageMissing, 0);
});

test('Noul accepts optional true/false descriptions and boundary probabilities without inventing confidence', () => {
  for (const criteria of [{}, { true: 'Yes' }, { false: 'No' }, { true: 'Yes', false: 'No' }]) {
    validateQuestions({ supported: { ...mixedQuestions.supported, criteria } });
  }
  for (const noul of [0, 0.5, 1]) {
    const data = mixedResponse();
    data.answers.supported.noul = noul;
    assert.deepEqual(validateResponse(data, mixedQuestions, model).answers.supported, { noul });
  }
});

test('Score supports two through ten dense bounded levels and their endpoint values', () => {
  for (const count of [2, 10]) {
    const criteria = Array.from({ length: count }, (_, index) => `Level ${index}`);
    const scoreQuestions = { relevance: { type: 'score', instructions: 'Rate', criteria } };
    validateQuestions(scoreQuestions);
    for (const score of [0, count - 1]) {
      const probabilities = Object.fromEntries(criteria.map((_, index) => [index, Number(index === score)]));
      const legend = Object.fromEntries(criteria.map((value, index) => [index, value]));
      const result = validateResponse({ model, answers: { relevance: { type: 'score', score, confidence: 1, probabilities, legend } } }, scoreQuestions, model);
      assert.deepEqual(result.answers.relevance, { score, confidence: 1, probabilities, legend });
    }
  }
});

test('Score keeps more precise probabilities exact while allowing two-decimal score rounding', () => {
  const data = mixedResponse();
  data.answers.relevance.probabilities = { 0: 0.1, 1: 0.5651, 2: 0.3349 };
  data.answers.relevance.score = 1.23; // Weighted sum is 1.2349.
  assert.equal(validateResponse(data, mixedQuestions, model).answers.relevance.score, 1.23);
  assert.ok(SCORE_ROUNDING_TOLERANCE < 0.00501);
  data.answers.relevance.score = 1.24;
  assert.throws(() => validateResponse(data, mixedQuestions, model), /invalid_response/);
});

test('observed independent Score/probability rounding requires a feasible underlying distribution', () => {
  // Safe numeric excerpt from the one synthetic diagnostic call: the displayed
  // score was 0.22, although the displayed probabilities have weighted sum 0.21.
  const data = mixedResponse();
  data.answers.relevance.probabilities = { 0: 0.79, 1: 0.21, 2: 0 };
  data.answers.relevance.score = 0.22;
  assert.equal(validateResponse(data, mixedQuestions, model).answers.relevance.score, 0.22);
  assert.deepEqual(data.answers.relevance.probabilities, { 0: 0.79, 1: 0.21, 2: 0 });
  data.answers.relevance.score = 0.23;
  assert.throws(() => validateResponse(data, mixedQuestions, model), /invalid_response/);
  // Endpoints cannot absorb arbitrary independent mass: probabilities must
  // correspond to a single underlying distribution that still sums to one.
  assert.equal(scoreMatchesProbabilities(8.96, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), true);
  assert.equal(scoreMatchesProbabilities(8.94, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), false);
  assert.equal(scoreMatchesProbabilities(0.5, [0.5, 0.5]), true);
  assert.equal(scoreMatchesProbabilities(0.52, [0.5, 0.5]), false);
  assert.equal(scoreMatchesProbabilities(0.3, [0.7, 0.29]), false); // Existing sum bound stays strict.
  assert.equal(scoreMatchesProbabilities(1, [0.5, , 0.5]), false);
  assert.equal(scoreMatchesProbabilities(NaN, [0.5, 0.5]), false);
  assert.equal(scoreMatchesProbabilities(1, [0, Infinity]), false);
  assert.equal(scoreMatchesProbabilities(1, Array(11).fill(1 / 11)), false);
});

for (const [name, question] of Object.entries({
  'structured instructions': { type: 'noul', instructions: { question: 'Supported?' } },
  'oversized instructions': { type: 'score', instructions: 'x'.repeat(4001), criteria: ['No', 'Yes'] },
  'null Noul criteria': { type: 'noul', instructions: 'Supported?', criteria: null },
  'explicit undefined Noul criteria': { type: 'noul', instructions: 'Supported?', criteria: undefined },
  'array Noul criteria': { type: 'noul', instructions: 'Supported?', criteria: ['No', 'Yes'] },
  'unknown Noul criterion': { type: 'noul', instructions: 'Supported?', criteria: { true: 'Yes', maybe: 'Maybe' } },
  'structured Noul criterion': { type: 'noul', instructions: 'Supported?', criteria: { false: { text: 'No' } } },
  'oversized Noul criterion': { type: 'noul', instructions: 'Supported?', criteria: { true: 'x'.repeat(2001) } },
  'missing Score criteria': { type: 'score', instructions: 'Rate' },
  'object Score criteria': { type: 'score', instructions: 'Rate', criteria: { 0: 'No', 1: 'Yes' } },
  'too few Score levels': { type: 'score', instructions: 'Rate', criteria: ['Only'] },
  'too many Score levels': { type: 'score', instructions: 'Rate', criteria: Array(11).fill('Level') },
  'sparse Score levels': { type: 'score', instructions: 'Rate', criteria: ['First', , 'Last'] },
  'structured Score level': { type: 'score', instructions: 'Rate', criteria: ['First', { text: 'Last' }] },
  'null Score level': { type: 'score', instructions: 'Rate', criteria: ['First', null] },
  'oversized Score level': { type: 'score', instructions: 'Rate', criteria: ['First', 'x'.repeat(2001)] },
}))
  test(`rejects ${name} before fetching`, async () => {
    let calls = 0;
    const client = createJevClient(options({ fetchImpl: async () => { calls++; } }));
    await assert.rejects(client.ask({ state: 'fixture', questions: { invalid: question } }), /invalid_questions/);
    assert.equal(calls, 0);
    assert.equal(client.stats().requests, 0);
  });

test('the twenty-question bound applies across mixed primitive types', () => {
  const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`q${index}`, Object.values(mixedQuestions)[index % 4]]));
  validateQuestions(twenty);
  assert.throws(() => validateQuestions({ ...twenty, extra: mixedQuestions.supported }), /invalid_questions/);
});

for (const [name, mutate] of Object.entries({
  'mismatched Noul type': data => { data.answers.supported.type = 'choice'; },
  'missing Noul value': data => { delete data.answers.supported.noul; },
  'boolean Noul': data => { data.answers.supported.noul = true; },
  'negative Noul': data => { data.answers.supported.noul = -0.01; },
  'Noul above one': data => { data.answers.supported.noul = 1.01; },
  'NaN Noul': data => { data.answers.supported.noul = NaN; },
  'infinite Noul': data => { data.answers.supported.noul = Infinity; },
  'mismatched Score type': data => { data.answers.relevance.type = 'noul'; },
  'missing Score': data => { delete data.answers.relevance.score; },
  'string Score': data => { data.answers.relevance.score = '1.2'; },
  'negative Score': data => { data.answers.relevance.score = -0.1; },
  'Score above scale': data => { data.answers.relevance.score = 2.01; },
  'NaN Score': data => { data.answers.relevance.score = NaN; },
  'infinite Score': data => { data.answers.relevance.score = Infinity; },
  'inconsistent Score': data => { data.answers.relevance.score = 1.4; },
  'missing Score confidence': data => { delete data.answers.relevance.confidence; },
  'invalid Score confidence': data => { data.answers.relevance.confidence = 1.01; },
  'array Score probabilities': data => { data.answers.relevance.probabilities = [0.2, 0.4, 0.4]; },
  'wrong Score index': data => { data.answers.relevance.probabilities = { 0: 0.2, 1: 0.4, '02': 0.4 }; },
  'missing Score probability': data => { delete data.answers.relevance.probabilities[2]; },
  'extra Score probability': data => { data.answers.relevance.probabilities[3] = 0; },
  'negative Score probability': data => { data.answers.relevance.probabilities[0] = -0.2; },
  'non-numeric Score probability': data => { data.answers.relevance.probabilities[0] = '0.2'; },
  'Score probability sum': data => { data.answers.relevance.probabilities[0] = 0.3; },
  'missing Score legend': data => { delete data.answers.relevance.legend; },
  'array Score legend': data => { data.answers.relevance.legend = mixedQuestions.relevance.criteria; },
  'changed Score legend': data => { data.answers.relevance.legend[0] = 'Direct answer'; },
  'missing Score legend level': data => { delete data.answers.relevance.legend[2]; },
  'extra Score legend level': data => { data.answers.relevance.legend[3] = 'Other'; },
  'wrong Score legend index': data => { data.answers.relevance.legend = { 0: 'Unrelated', 1: 'Related topic', '02': 'Direct answer' }; },
  'swapped mixed answers': data => { [data.answers.supported, data.answers.relevance] = [data.answers.relevance, data.answers.supported]; },
}))
  test(`rejects ${name} in a mixed response`, () => {
    const data = mixedResponse();
    mutate(data);
    assert.throws(() => validateResponse(data, mixedQuestions, model), /invalid_response/);
  });

test('invalid mixed answers preserve failed-call cost accounting without retries', async () => {
  let calls = 0;
  const client = createJevClient(options({ fetchImpl: async () => {
    calls++;
    const data = mixedResponse();
    data.answers.relevance.score = 0;
    return Response.json(data);
  } }));
  await assert.rejects(client.ask({ state: 'fixture', questions: mixedQuestions }), /invalid_response/);
  assert.equal(calls, 1);
  assert.equal(client.stats().usageMissing, 1);
  assert.equal(client.stats().estimatedCostUsd, null);
  assert.ok(client.stats().reservedMaxCostUsd > 0);
});

test('typed request uses the fixed official endpoint; response contains no arbitrary provider fields', async () => {
  const client = createJevClient(
    options({
      fetchImpl: async (url, init) => {
        assert.equal(url, JEV_ENDPOINT);
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.Authorization, 'Bearer fixture-key');
        assert.deepEqual(JSON.parse(init.body).questions, questions);
        return Response.json({ ...response(), echoedSecret: 'do-not-return' });
      },
    }),
  );
  const result = await client.ask({ state: 'fixture', questions });
  assert.equal(result.answers.decision.choice, 'yes');
  assert.equal(result.echoedSecret, undefined);
  assert.equal(client.stats().inputTokens, 100);
  assert.equal(client.stats().usageMissing, 0);
});

for (const [name, mutate] of Object.entries({
  'wrong model': (data) => {
    data.model = 'jev-latest';
  },
  'unoffered choice': (data) => {
    data.answers.decision.choice = 'execute';
  },
  'missing probability': (data) => {
    delete data.answers.decision.probabilities.no;
  },
  'extra probability': (data) => {
    data.answers.decision.probabilities.maybe = 0;
  },
  'invalid sum': (data) => {
    data.answers.decision.probabilities.no = 0.9;
  },
  'nonmax choice': (data) => {
    data.answers.decision.choice = 'no';
  },
  'invalid confidence': (data) => {
    data.answers.decision.confidence = null;
  },
  'missing type': (data) => {
    delete data.answers.decision.type;
  },
  'extra answer': (data) => {
    data.answers.other = data.answers.decision;
  },
}))
  test(`rejects ${name}`, () => {
    const data = response();
    mutate(data);
    assert.throws(() => validateResponse(data, questions, model), /invalid_response/);
  });

test('help/offline default, missing credentials and aliases never fetch', async () => {
  let called = 0;
  for (const config of [{ live: false }, { apiKey: '' }, { model: 'jev-preview' }]) {
    const client = createJevClient(
      options({
        ...config,
        fetchImpl: async () => {
          called++;
        },
      }),
    );
    await assert.rejects(client.ask({ state: 'x', questions }));
  }
  assert.equal(called, 0);
});

test('request, byte, secret and spend guards stop before network', async () => {
  const client = createJevClient(options({ maxRequests: 1 }));
  await client.ask({ state: 'x', questions });
  await assert.rejects(client.ask({ state: 'x', questions }), /budget_exhausted/);
  await assert.rejects(createJevClient(options({ maxInputBytes: 10 })).ask({ state: 'x', questions }), /input_too_large/);
  await assert.rejects(createJevClient(options({ maxCostUsd: 0.000001 })).ask({ state: 'x', questions }), /budget_exhausted/);
  await assert.rejects(createJevClient(options()).ask({ state: 'fixture-key', questions }), /secret_in_input/);
  await assert.rejects(createJevClient(options({ apiKey: ' fixture-key \n' })).ask({ state: 'fixture-key', questions }), /secret_in_input/);
});

test('throttling and invalid/error payloads cannot leak provider content or count as free', async () => {
  const client = createJevClient(options({ fetchImpl: async () => new Response('private fixture-key data', { status: 429 }) }));
  await assert.rejects(client.ask({ state: 'x', questions }), (error) => error.message === 'provider_throttled');
  assert.equal(client.stats().usageMissing, 1);
  assert.equal(client.stats().estimatedCostUsd, null);
  assert.equal(client.stats().knownCostSubtotalUsd, 0);
  assert.ok(client.stats().reservedMaxCostUsd > 0);
  await assert.rejects(createJevClient(options({ fetchImpl: async () => new Response('{bad fixture-key') })).ask({ state: 'x', questions }), /provider_unavailable/);
});

test('oversized streamed provider response is bounded', async () => {
  const client = createJevClient(options({ fetchImpl: async () => new Response('x'.repeat(256001)) }));
  await assert.rejects(client.ask({ state: 'x', questions }), /response_too_large/);
});

test('missing usage is unknown, not zero billed', async () => {
  const client = createJevClient(
    options({
      fetchImpl: async () => {
        const data = response();
        delete data.usage;
        return Response.json(data);
      },
    }),
  );
  await client.ask({ state: 'x', questions });
  assert.equal(client.stats().usageMissing, 1);
  assert.equal(client.stats().estimatedCostUsd, null);
});
