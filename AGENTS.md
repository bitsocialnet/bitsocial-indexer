# Web UI agent workflow

The React application is in `webui/`. Run its commands from that directory and use npm with the committed `package-lock.json`.

## React diagnostics and performance

- Run `npm run doctor` before and after meaningful React changes. This uses the pinned local React Doctor CLI and reports findings without automatically blocking on the existing backlog. Review the diagnostics and fix regressions introduced by the change; explain any remaining relevant findings.
- Run `npm run typecheck` and `npm run build` to validate React changes. React Doctor complements these checks.
- For runtime performance investigations, start `npm run dev`, then run `npm run doctor:scan -- http://localhost:3000`. Pass the actual local URL explicitly if using another port. Reproduce the slow interaction, stop the recording as prompted, and compare the trace before and after the change. Use an interactive terminal and press Enter to stop recording. Add `--format json` for a structured report and `--trace-out <path>` to choose the trace file.
- Runtime tracing runs from the CLI. Do not add profiling libraries or diagnostic globals to the application bundle.

## Visual feedback

Agentation is loaded by `webui/components/DevTools.tsx` only in development, with server rendering disabled. Use its toolbar to annotate elements and copy the structured feedback into the coding agent conversation. It does not require an MCP server for this clipboard workflow. Keep annotation tooling out of production bundles and verify that constraint when editing the integration.
