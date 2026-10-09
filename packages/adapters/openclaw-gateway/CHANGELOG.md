# @paperclipai/adapter-openclaw-gateway

## Unreleased

### Patch Changes

- Preserve one authoritative `agent.wait` request until OpenClaw supplies a terminal receipt, while continuing to enforce Paperclip's local idle and cancellation deadlines.
- Require host-local credential use in OpenClaw wake instructions so remote execution-tool secret boundaries cannot corrupt the run-scoped Paperclip bearer.
- Give agents a shell-safe credential load prefix and forbid inline assignment before curl, which expands the bearer before the assignment takes effect.
- Document the recovery, interaction, run-inspection, and peer-wake endpoints required by control-plane steward routines in the cloud wake boundary.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies
  - @paperclipai/adapter-utils@0.3.0
