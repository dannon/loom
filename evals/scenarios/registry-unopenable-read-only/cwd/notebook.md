# Eval fixture notebook

## Plan A: read QC [remote]

### Steps

- [ ] 1. **Trim reads** {#plan-a-step-1} -- fastp on the raw reads
  - Routing: Galaxy
  - Verification: a trimmed fastqsanger in the history
- [ ] 2. **Align** {#plan-a-step-2} -- bwa-mem
  - Routing: Galaxy

```loom-proposal
proposal_id: prop-abc123
step_anchor: plan-a-step-1
label: Trim reads
target: {"kind":"tool","tool_id":"toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.23.4+galaxy0","version":"unpinned"}
server_url: https://usegalaxy.org
history_id: 0a248a1f62a0cc04
inputs: [{"slot":"reads","src":"hda","id":"4b6e2f1a9c3d5e70"}]
overrides: [{"param":"threads","value":4,"rationale":"the queue gives four cores"}]
predicate: {"kind":"exists_with_ext","ext":"fastqsanger","min_count":1}
assertions: []
```
