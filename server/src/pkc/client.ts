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

export function getPkcClient(): Promise<PkcClient> {
  clientPromise ??= connect();
  return clientPromise;
}

async function connect(): Promise<PkcClient> {
  // Non-literal specifier keeps this out of static type resolution: the package
  // is an optional runtime integration, not needed to build/run an empty index.
  const specifier = '@pkcprotocol/pkc-js';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(specifier);
  const PKC = mod.default ?? mod;

  const pkc = await PKC({ pkcRpcClientsOptions: [config.pkcRpcUrl] });
  pkc.on?.('error', (err: unknown) => console.error('[pkc] error event:', err));
  console.log(`[pkc] connected via ${config.pkcRpcUrl}`);

  return {
    getCommunity: (address) => pkc.getCommunity({ address }),
    getComment: (cid) => pkc.getComment({ cid }),
    destroy: async () => {
      await pkc.destroy?.();
      clientPromise = null;
    },
  };
}
