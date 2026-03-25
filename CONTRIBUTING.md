# Contributing to burn0

Thanks for your interest in contributing to burn0! Whether it's a bug fix, new service detection, documentation improvement, or a feature idea — we appreciate it.

## Quick Start

```bash
git clone https://github.com/burn0-dev/burn0.git
cd burn0
npm install
npm run build
npm test
```

If all tests pass, you're ready to go.

## Project Structure

```
src/
├── cli/              # CLI commands (init, report, dev, connect, status)
├── config/           # Environment variables + local config store
├── interceptor/      # fetch + node:http monkey-patching
│   ├── fetch.ts      # globalThis.fetch interceptor
│   ├── http.ts       # node:http/https interceptor
│   ├── stream.ts     # Streaming response handler
│   └── guard.ts      # Re-entrance guard (prevents infinite loops)
├── services/         # Service detection + pricing catalog
│   ├── catalog.ts    # 50+ service definitions with hostname patterns
│   ├── detect.ts     # Hostname → service resolver
│   ├── map.ts        # Service map builder
│   └── scan.ts       # Codebase scanner for service detection
├── transport/        # Where cost events go
│   ├── local.ts      # SQLite local ledger
│   ├── local-pricing.ts  # Bundled pricing data
│   ├── api.ts        # Cloud API transport
│   ├── batch.ts      # Event batching for cloud mode
│   ├── dispatcher.ts # Routes events to local/cloud
│   └── logger.ts     # Terminal output formatting
├── index.ts          # Main entry — patches fetch/http on import
├── register.ts       # Side-effect import entry point
├── restore.ts        # Unpatch fetch/http
├── track.ts          # Feature attribution wrapper
└── types.ts          # Shared TypeScript types
```

## Development Workflow

### Create a branch

```bash
git checkout -b feat/my-feature
# or
git checkout -b fix/my-bugfix
```

### Make your changes

burn0 is built with TypeScript and compiled with [tsup](https://github.com/egoist/tsup). During development:

```bash
npm run dev          # Watch mode — rebuilds on save
npm test             # Run all tests
npm run test:watch   # Watch mode for tests
npm run lint         # Type-check without emitting
```

### Write tests

Tests live in `tests/` and mirror the `src/` directory structure. We use [Vitest](https://vitest.dev/).

```bash
# Run a specific test file
npx vitest run tests/services/detect.test.ts

# Run tests matching a pattern
npx vitest run -t "should detect OpenAI"
```

Every PR should include tests for new functionality. If you're fixing a bug, add a test that would have caught it.

### Submit a PR

Keep PRs focused — one feature or fix per PR. Write a clear description of what changed and why. Reference any related issues (`Fixes #123`).

## Common Contributions

### Adding a new service

This is the easiest way to contribute. burn0 detects services by matching hostnames. To add a new service:

**Add the service to `src/services/catalog.ts`:**

```typescript
{
  name: "your-service",
  display: "Your Service",
  category: "ai",  // or "payment", "email", "database", "infrastructure", "analytics", "search", "messaging", "media"
  hostPatterns: ["api.yourservice.com", "*.yourservice.io"],
  pricingModel: "per-request",
  defaultCostPerRequest: 0.001,
}
```

**Add a detection test in `tests/services/detect.test.ts`:**

```typescript
it("should detect Your Service", () => {
  expect(detect("https://api.yourservice.com/v1/query")).toBe("your-service");
});
```

**Run the tests:**

```bash
npm test
```

That's it. Three files touched, and burn0 now tracks a new service.

### Improving cost accuracy

If you notice burn0 is reporting inaccurate costs for a service, check `src/transport/local-pricing.ts`. Pricing data is bundled and may need updating when providers change their rates.

### Fixing a bug

Write a failing test first. Fix the bug. Verify the test passes.

### Documentation

Docs improvements are always welcome. The README is the primary docs surface — keep it concise and example-driven.

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- Functions should be small and focused
- Prefer `const` over `let`
- Error handling: burn0 should **never throw** in production paths — graceful degradation is a core principle
- Performance: interception must be sub-millisecond — benchmark if in doubt

## Architecture Principles

- **Zero config** — burn0 should work with a single import. No setup wizards required for basic functionality.
- **Never throw** — If burn0 fails internally, the user's app must continue working normally.
- **Never read content** — burn0 extracts metadata only (service, model, tokens, status, latency). Never request/response bodies.
- **Sub-millisecond overhead** — Interception is synchronous, but all cost computation and I/O is async.
- **Local first** — Everything works without an API key. Cloud features are opt-in.

## Questions?

- Open a [GitHub Discussion](https://github.com/burn0-dev/burn0/discussions) for questions or ideas
- Check [existing issues](https://github.com/burn0-dev/burn0/issues) before filing a new one
- Tag issues with `good first issue` if you think they're beginner-friendly

## License

By contributing to burn0, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
