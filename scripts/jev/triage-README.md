# Opt-in sanitized log triage experiment

This developer helper suggests severity and a human investigation category for **explicitly selected, already sanitized** messages. It never reads service logs automatically, suppresses alerts, restarts services, sends notifications, or changes runtime settings. Use original evidence and ordinary diagnosis to verify every suggestion.

```bash
node scripts/jev/triage.mjs --input scripts/jev/fixtures/triage.json
node --test scripts/jev/tests/triage.test.mjs
# Intentional paid API calls; uses the existing private machine configuration:
node scripts/jev/triage.mjs --input scripts/jev/fixtures/triage.json \
  --live --max-requests 10 --max-cost-usd 0.01 > /private/triage-report.json
```

Offline validates and groups without reading credentials or sending requests. It labels every group `unverified`, with reason `offline_no_model`; exit 0 means only that input validation succeeded. Live calls reuse the shared [Jev client/config](README.md), a pinned model, deadlines, request limits, and conservative input-byte/token cost reservations. The estimate uses the client's explicit price assumption, not an invoice guarantee. Missing usage remains unknown. There are no retries or disk caches in this helper.

Input is a single JSON object, not raw JSONL or a log-directory path:

```json
{
    "version": 1,
    "provenance": "sanitized-unlabeled",
    "sanitized": true,
    "events": [
        {
            "id": "sample-1",
            "source": "indexer",
            "message": "Required RPC connection refused; indexing remains stopped.",
            "count": 12
        }
    ]
}
```

Sources are `moderation`, `indexer`, `spam-blocker`, and `archive-web`. Opaque IDs must be unique. `count` is the known occurrence count; omit it for one. Only identical source/message pairs are grouped, and counts are summed; similar messages stay separate. Limits are 64KB selected JSON, 200 events, 20 distinct groups, 1,200 characters per message, and one million total occurrences. Inputs exceeding a limit are rejected, not silently truncated.

Remove secrets, headers/cookies, IP addresses, user/publication data, signatures/CIDs, private paths, and URLs before selecting a file. Common credential patterns and identifiers are rejected as an extra guard; it cannot prove arbitrary text is sanitized. The live client separately rejects the loaded API key if it occurs in a request body. Unknown fields are rejected. Do not point this helper at a raw audit, journal, database export, or request log. The `sanitized` flag is an operator attestation, not an automatic guarantee.

One bounded request per group asks two independent `Choice` questions over the same state: operational severity and investigation category. It does not generate reasons, shell commands, or remediation. Typed labels include `uncertain`. An uncertain choice, chosen probability below 0.8, confidence below 0.6, or error/critical severity combined with `observe` becomes `unverified`. Provider/schema/config/budget errors also remain `unverified`. These are conservative experiment defaults, not calibrated reliability guarantees. No action follows a classification.

Reports contain group hashes, allowlisted source labels, counts, typed judgments, timing, aggregate usage, and safe error codes. The input hash, rubric version/hash (including confidence/consistency gates), and validated response model identify the experiment. Each group's model is null offline or before a valid response; `models` lists only observed pinned models. Reports omit original messages, selected event IDs, raw errors, paths, and credentials. Group hashes identify matching selected text; keep reports private if even that linkage is sensitive. A live run exits 2 when any group is unverified, or 1 for synthetic-label mismatches with no abstentions; it still emits the report.

The committed fixture is **authored synthetic data**, inspired by repository source surfaces. It is not copied traffic and is not independently human-labeled evidence. Only `provenance: "synthetic"` may include `expected: {severity, action}`; real sanitized samples are deliberately unlabeled. Metrics count unique labeled groups, not repeated occurrences. Abstentions are separate from correct labels and mismatches. A false dismissal is a classified informational/observe result for a synthetic case whose expected severity or category required investigation. It does not mean an alert was actually dismissed. No production accuracy/recall or alert-suppression claim follows from fixture agreement.

This follows the current TypeSafe [Choice guidance](https://docs.typesafe.ai/primitives/choice) and [classification-with-confidence example](https://docs.typesafe.ai/cookbooks/classification_using_confidence). The probabilities express the model's judgment; they are not independently verified operational facts.

## Repository scope

The backend logs crawler/source configuration failures in `server/src/crawler/crawler.ts`, RPC error events in `server/src/pkc/client.ts`, and blocklist/override input failures in `server/src/blocklist.ts` and `server/src/nsfw.ts`. Fastify also has request logging. These records can contain community identifiers, endpoint details, and arbitrary error objects. Prepare sanitized summaries manually; no crawler, database, request logger, or configuration is changed by this helper.
