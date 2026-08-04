# burn0-test

Manual test app for burn0. Generates real traffic through the actual capture
layer (`--import @burn0/core/register`) so you can explore the dashboard with
live data. No API keys needed — LLM calls go to a local OpenAI-shaped mock.

## Scripts

```bash
pnpm demo     # one burst: 3 LLM calls (w/ fake sk- secret → see redaction),
              # 2 real GitHub calls, 1 normalized-endpoint call, 1 error (500)
pnpm stream   # SSE streaming call — tokens extracted from final chunk, app stream untouched
pnpm loop     # one request every 2s forever — pair with `burn0 watch` / Network tab
pnpm tagged   # withTags/burn0.tag attribution — check the Debug screen tags line
```

Then look at the data:

```bash
node ../cli/dist/index.mjs          # TUI
node ../cli/dist/index.mjs today    # one-shot summary
node ../cli/dist/index.mjs watch    # live tail (run alongside `pnpm loop`)
```

Data lands in `~/.burn0/burn0.db`. Delete that file to reset.
Rebuild first if you changed core/cli: `pnpm -r build` from the repo root.
