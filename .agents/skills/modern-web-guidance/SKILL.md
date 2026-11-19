---
name: modern-web-guidance
description: Look up browser support and implementation guidance when choosing a native control, focus behavior, browser API, or browser-sensitive layout.
---

From `webui/`, use the CLI pinned in its npm lockfile. Search for the browser behavior, then retrieve the matching guide by its returned ID.

```sh
DISABLE_TELEMETRY=1 ./node_modules/.bin/modern-web-guidance search "native search input"
DISABLE_TELEMETRY=1 ./node_modules/.bin/modern-web-guidance retrieve forms
```

Apply the relevant advice to the component under review. Preserve the design and browser support requirements for Bitsocial Indexer. Verify the observable behavior using the [web UI verification instructions](../../../AGENTS.md).
