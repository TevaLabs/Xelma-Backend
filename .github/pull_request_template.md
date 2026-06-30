<!--
Thanks for contributing to Xelma Backend!
Fill out every section. PRs with an incomplete checklist may be sent back.
-->

## Summary

<!-- What does this PR change and why? Link the issue it closes. -->

Closes #

## Dual-entrypoint architecture

This repo ships **two Express applications**. `npm run dev` (`src/index.ts`) is the
default production path and is the one reviewers and CI care about. `src/app.ts`
(`npm run dev:hackathon`) is a separate mock/demo entrypoint.

Several past issues were closed while the functionality existed **only** in one
entrypoint. Before requesting review, confirm your change behaves correctly on the
default `npm run dev` path. See [docs/architecture.md](../docs/architecture.md) for
the entrypoint map and the checklist for adding new routes.

## Affected endpoints

<!-- List every HTTP route / WebSocket event this PR adds, changes, or removes.
     Write "None" if this PR touches no endpoints. -->

-

## Checklist

- [ ] Verified the change works on the default `npm run dev` (`src/index.ts`) entrypoint.
- [ ] If the change affects shared functionality, verified it on the hackathon `src/app.ts` entrypoint too (or explained why it does not apply).
- [ ] Listed all affected endpoints above (or marked "None").
- [ ] Added or updated tests covering the change.
- [ ] `npm run lint` and `npm test` pass locally.
- [ ] Updated docs (README, OpenAPI annotations, `docs/`) where behavior changed.

## Notes for reviewers

<!-- Anything else: trade-offs, follow-ups, screenshots, migration risk. -->
