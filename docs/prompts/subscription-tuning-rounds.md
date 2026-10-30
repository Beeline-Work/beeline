# Tuning decisions (tune partition only)

Held-out results have not been opened or used for these choices.

## Round zero continuation

Earth returned its complete attempted tune cohort (54 cases per variant): full
passed 33/41 scored cases, deferred passed 34/40. Unscored counts were 13 and
14. Its median aggregate input grew from 46,898.5 to 66,801 with deferred
loading. Local Luna and Sol runs were interrupted before completion; resume
their saved samples rather than generate replacement seeds. Their results must
be included before any frontier or stopping decision.

## Round one candidates

These candidates are selected from Earth's completed round-zero failure groups
and token accounting. They are independent changes from r0-deferred, not a
combined winner. Each must run on every available assigned model.

- `r1-short`: cap advertised descriptions at forty words. Change only description
  length. Deferred round zero increased Terra's aggregate input, so test whether
  shorter repeated MCP listings reduce continuation bloat. Schemas stay intact.
- `r1-order`: add `order` to the fully loaded core. Change only core count.
  Terra's deferred `finish-orders-then-ends` sample made no calls, while its full
  counterpart passed. Making the terminal assignment tool immediately callable
  tests this discovery failure without adding a new prompt rule.

Neither choice is a recommendation or a frozen frontier. Compare paired scored
cohorts and retain raw exclusions. The full baseline and round-zero deferred
samples remain the original runs; do not rerun them to improve scores.
