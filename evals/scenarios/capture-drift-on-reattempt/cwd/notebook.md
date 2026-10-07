# QC analysis

## Plan A: Read QC [galaxy]

- [ ] 1. **Trim reads** {#plan-a-step-1} — fastp
- [ ] 2. **Trim all samples** {#plan-a-step-2} — fastp over the collection

```loom-galaxy-page
page_id: aaaa000000000001
page_slug:
galaxy_server_url: "https://usegalaxy.org"
history_id: 0a248a1f62a0cc04
last_synced_revision:
bound_at: 2026-10-07T09:00:00Z
```

```loom-job
job_id: f100000000000001
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-1
label: fastp
tool_id: toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.23.4
submitted_at: 2026-10-07T09:30:00.000Z
status: completed
summary: ""
server_verified: true
attempt_id: 01K6ZQ7B3M2N4P5Q6R7S8T9V0W
history_id: 0a248a1f62a0cc04
submitted_by: harness
enrichment: complete
enrichment_attempts: 1
jobs: [{"job_id":"f100000000000001","tool_id":"toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.23.4","tool_version":"0.23.4"}]
```

```loom-job
job_id: f100000000000002
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-1
label: fastp
tool_id: toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0
submitted_at: 2026-10-07T10:00:00.000Z
status: completed
summary: ""
server_verified: true
attempt_id: 01K6ZQ7B3M2N4P5Q6R7S8T9V0X
history_id: 0a248a1f62a0cc04
submitted_by: harness
enrichment: pending
enrichment_attempts: 0
jobs: [{"job_id":"f100000000000002","tool_id":"toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0","tool_version":"0.24.0"}]
```
