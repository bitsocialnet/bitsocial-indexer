import assert from 'node:assert/strict';
import { communityAddress, communityTitle, startFixtureApi, threadCid, threadTitle } from './fixture-api.mjs';

const archiveRoutes = false;
const communityPath = archiveRoutes ? `/${communityAddress}` : `/p/${communityAddress}`;
const threadPath = archiveRoutes ? `/${communityAddress}/thread/${threadCid}` : `/c/${threadCid}`;

// These are initial, deliberately generous development budgets, not production SLAs.
// The shared runner records each sample and fails missing collector/timing coverage.
const navigationBudget = { maxCommits: 60, maxRenderMs: 250, maxActionMs: 10000 };

async function expectPosts(page, count) {
  await page.locator('.post-title').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('.post-title').count(), count, 'Expected populated fixture results');
  assert.equal(await page.getByText('The indexer API isn’t reachable.').count(), 0);
}

async function prepare({ page }) {
  await page.addInitScript(() => { window.__PROFILING__ = true; });
}

export default {
  targets: [{
    name: 'webui',
    setup: () => startFixtureApi(),
    server: {
      command: ['node', 'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '{port}'],
      env: { NEXT_PUBLIC_REACT_PERF: '1', REACT_PERF_SCENARIO: '1', NEXT_TELEMETRY_DISABLED: '1' },
      readyPath: '/',
    },
    scenarios: [
      {
        name: 'populated-navigation',
        path: '/',
        prepare,
        async run({ page, measure, origin }) {
          await expectPosts(page, 3);
          await measure('open-community', async () => {
            await page.locator('.community-list a').click();
            await page.waitForURL(`${origin}${communityPath}`);
            await page.getByRole('heading', { name: communityTitle, exact: true }).waitFor();
            await expectPosts(page, 3);
          }, navigationBudget);
          await measure('open-thread', async () => {
            await page.getByRole('link', { name: threadTitle, exact: true }).click();
            await page.waitForURL(`${origin}${threadPath}`);
            await page.getByRole('heading', { name: threadTitle, exact: true }).waitFor();
            await page.getByText('Fixture reply 2', { exact: true }).waitFor();
            assert.equal(await page.locator('.reply').count(), 2);
          }, navigationBudget);
          if (archiveRoutes) {
            await measure('open-reply-permalink', async () => {
              await page.locator('.permalink').first().click();
              await page.waitForURL(`${origin}/${communityAddress}/thread/perf-reply-001`);
              await page.locator('#pperf-reply-001.reply-target').waitFor();
              await page.getByText('Fixture reply 1', { exact: true }).waitFor();
            }, { ...navigationBudget, components: { ReplyTarget: { minUpdates: 1, maxUpdates: 3 } } });
          }
        },
      },
      {
        name: 'search-results',
        path: '/',
        prepare,
        async run({ page, measure, origin }) {
          await expectPosts(page, 3);
          // This form is native HTML, not a stateful React input. Its submit navigates
          // to a new document; the report covers that document's client hydration.
          await page.locator('.header-search input[name="q"]').fill('needle');
          await measure('submit-search', async () => {
            await page.locator('.header-search button[type="submit"]').click();
            await page.waitForURL(`${origin}/search?q=needle`);
            await page.getByRole('heading', { name: 'Results for “needle”', exact: true }).waitFor();
            await expectPosts(page, 1);
            await page.getByRole('link', { name: threadTitle, exact: true }).waitFor();
          }, navigationBudget, { navigation: true });
        },
      },
    ],
  }],
};
