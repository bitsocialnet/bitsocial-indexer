/**
 * Thin wrapper around the bitsocial network client. The crawler talks to a
 * `bitsocial-cli` daemon over PKC RPC.
 *
 * It's lazily imported so the neutral, empty-by-default indexer never needs the
 * dependency or a running daemon — only an instance that actually indexes
 * communities connects here.
 */
import { config } from '../config.js';

export interface PkcClient {
  /** Resolve a community and its current post CIDs. */
  getCommunity(address: string): Promise<unknown>;
  /** Resolve a single comment by CID. */
  getComment(cid: string): Promise<unknown>;
  destroy(): Promise<void>;
}

let clientPromise: Promise<PkcClient> | null = null;
let resetPromise: Promise<void> | null = null;

/**
 * Set by a routine recycle (see the crawler) so the reconnect it causes is not
 * announced: one line per crawl pass would bury the connects that matter, the
 * ones after a timeout or a daemon restart.
 */
let quietReconnect = false;

/**
 * Identifies the cached client. Bumped on every connect, so a doomed client's
 * late failure can only retire itself — never a healthy replacement that a
 * concurrent crawl pass has already installed.
 */
let generation = 0;

/**
 * Keep credentials and opaque path segments out of logs. PKC RPC uses the
 * first URL path segment as the remote authentication key, and URLs may also
 * carry userinfo or query credentials.
 */
export function formatPkcRpcUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '[invalid PKC RPC URL]';

    const hasOpaquePath = url.pathname !== '' && url.pathname !== '/';
    return `${url.protocol}//${url.host}${hasOpaquePath ? '/[redacted]' : ''}`;
  } catch {
    return '[invalid PKC RPC URL]';
  }
}

/**
 * Errors meaning the cached client can never work again: the daemon it was
 * connected to is gone (restarted), or was never up when we connected.
 */
export function isConnectionError(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === 'ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC';
}

/** Drop the cached client, but only while it is still the one `gen` created. */
function retire(gen: number): void {
  if (gen === generation) clientPromise = null;
}

export function getPkcClient(): Promise<PkcClient> {
  if (!clientPromise) {
    const gen = ++generation;
    clientPromise = connect(gen).catch((err: unknown) => {
      // Never cache a failed connect: the daemon may simply not be up yet, and
      // the next crawl pass has to be able to retry.
      retire(gen);
      throw err;
    });
  }
  return clientPromise;
}

/**
 * Retire and close the current RPC client — after a timed-out call, or as the
 * crawler's routine end-of-pass recycle (`quiet`, which also silences the
 * connect log line of the replacement). Clearing the cache first lets new work
 * reconnect immediately; the generation guard keeps the old client's late
 * teardown from evicting that replacement.
 */
export function resetPkcClient(opts: { quiet?: boolean } = {}): Promise<void> {
  const doomed = clientPromise;
  clientPromise = null;
  if (!doomed) return resetPromise ?? Promise.resolve();
  if (opts.quiet) quietReconnect = true;

  const reset = doomed
    .then((client) => client.destroy())
    .catch(() => {});
  resetPromise = reset;
  void reset.finally(() => {
    if (resetPromise === reset) {
      resetPromise = null;
    }
  });
  return reset;
}

/** Test seam for exercising reset ordering without opening a real RPC socket. */
export function setPkcClientForTest(client: Promise<PkcClient> | null): void {
  clientPromise = client;
}

async function connect(gen: number): Promise<PkcClient> {
  // Non-literal specifier keeps this out of static type resolution: the package
  // is an optional runtime integration, not needed to build/run an empty index.
  const specifier = '@pkcprotocol/pkc-js';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(specifier);
  const PKC = mod.default ?? mod;

  // Consumed up front so a connect that fails here still uses up the quiet
  // flag: the connect that eventually recovers from that failure is news.
  const quiet = quietReconnect;
  quietReconnect = false;

  const pkc = await PKC({ pkcRpcClientsOptions: [config.pkcRpcUrl] });
  pkc.on?.('error', (err: unknown) => console.error('[pkc] error event:', err));
  if (!quiet) console.log(`[pkc] connected via ${formatPkcRpcUrlForLog(config.pkcRpcUrl)}`);

  /**
   * Run one RPC call, retiring this client if the connection turned out to be
   * dead. A daemon restart never surfaces on the existing handle — every later
   * call just fails — so without this the crawler stays wedged, and every
   * community fails forever, until the process is restarted by hand.
   */
  async function call<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (isConnectionError(err)) {
        retire(gen);
        void Promise.resolve(pkc.destroy?.()).catch(() => {});
      }
      throw err;
    }
  }

  return {
    getCommunity: (address) => call(() => pkc.getCommunity({ address })),
    getComment: (cid) => call(() => pkc.getComment({ cid })),
    destroy: async () => {
      retire(gen);
      await pkc.destroy?.();
    },
  };
}
