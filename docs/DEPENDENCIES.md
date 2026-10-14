# Dependency notes

## Node 22

`.nvmrc`, the Dockerfile and `engines.node` all target **Node 22** (active LTS).
Node 18 and Node 20 are both end-of-life.

If `nvm`/`fnm` isn't set up locally, `brew install node@22`. Everything except the
test runner works on Node 18, so development isn't blocked by this.

## `npm audit` reports 6 advisories — all dev-only

All six sit in the `vitest` → `vite`/`esbuild`/`tinypool` chain: a dev-server
path-traversal class of issue in the test runner. **None is in the shipped
runtime** — `express`, `pg`, `pdfjs-dist`, `@anthropic-ai/sdk`, `yaml` and `zod`
are all clean.

The only version that clears them is `vitest@5`, which requires Node ^22.12.
`vitest` is pinned at 2.x so the test suite runs on the Node currently installed
on this machine (18). On Node 22+:

```
npm install -D vitest@latest   # clears all six
```

Deliberate trade: breaking the test runner — the feedback loop the accuracy
harness depends on — to clear advisories with no runtime exposure would be the
wrong call.
