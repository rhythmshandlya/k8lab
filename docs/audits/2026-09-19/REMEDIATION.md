# Problems engineering remediation

This change addresses the 16 findings in the Phase 1 Problems audit. The learning product retains its three documented execution mechanisms: browser simulation, modelled incidents, and static architecture review. A passing submission means it satisfies the published exercise contract, not that arbitrary YAML has been run on a real cluster.

| Audit finding | Remediation |
| --- | --- |
| 1. Stale editor/runtime verdicts | Serialize runtime operations and bind verdicts to the exact applied file revision. Unapplied edits cannot pass. Formal submissions capture immutable files, disable edits during work, and ignore completions after account/navigation changes. |
| 2. Contradictory healthy fixture states | Reject node pins/selectors inconsistent with the modelled placement and unmodelled command, affinity, scheduling, init-container and runtime changes. Invalid configurations cannot switch fixtures to healthy. |
| 3. Missing Kubernetes validity checks | Vendor pinned official Kubernetes and external API schemas; check all references against Kubernetes 1.34–1.36. Validate API identity, required fields, types, unknown fields, probes, ports, restart policy and restricted Pod settings. Bound YAML size/depth/aliases and runtime replicas. |
| 4. Invalid restricted canonical workloads | Correct both affected architecture solutions with non-root, seccomp, privilege-escalation and capability settings. Restricted checks derive from actual admission labels. |
| 5. No-op graceful drain | Require the application's supported delay to cover the ten-second propagation window and fit inside termination grace. No-op/unknown hooks do not count as a drain. |
| 6. Missing investigation evidence | Events cover all exposed namespaces and identify the namespace. Cluster inspection includes control-plane namespaces. |
| 7. Client-authoritative scores | New authenticated server judge replays submitted files. Only verified, current-version verdicts can award XP or enter public aggregates. Server-side hint costs, server UTC solve days, owner checks, rate limits and idempotency apply. Legacy/guest claims cannot award account XP. |
| 8. Dependency advisories | Update Next.js, Vitest, AJV and transitive security floors, including sharp and the legacy esbuild loader. Production dependency audit has no reported vulnerabilities. |
| 9. Hidden architecture literals | Starter manifests publish the resource identity and exact assertion contract. |
| 10. Silently ignored commands | Reject unsupported flags, formats, irrelevant options, missing option values and excess arguments. Unsupported dry-run/force requests never mutate the runtime. |
| 11. Terminal state loss | Keep Terminal mounted across investigation tabs, preserving output and input history. |
| 12. Narrow-screen workspace | Provide Problem, Editor & tools and Cluster navigation; show the selected pane at full width. Reflow actions and keep mobile quick commands from consuming terminal space. |
| 13. Missing submission record | Store immutable files, content version, judge version, timestamp, verdict and check details. Expose the latest 20 attempts with restore/export; restoring files still requires Apply. Guest history stays local and is explicitly labelled. |
| 14. Fragile drafts | Separate guest/account keys, capture owners in pending writes, remove silent 40-draft eviction, retain queued data after quota errors, expose retry/export, archive old content versions, and sync authenticated drafts with optimistic revision conflicts. Older versions remain recoverable. |
| 15. Stale streaks | Calculate active streaks against UTC today/yesterday and refresh the client on focus and at minute intervals. |
| 16. Qualification gaps | Add independent upstream-schema qualification, adversarial regressions, real Postgres-engine persistence and route tests, server judge replay for all 60 problems, and browser editor/apply/submit/history coverage for every published problem in CI. |

## Rollout

Apply Drizzle migrations `0007_verified_problems.sql` and `0008_problem_drafts.sql` before deploying the application. They add verification/version markers and owner-scoped draft storage. Existing rows remain preserved as unverified history; they are deliberately excluded from verified XP, streaks and rankings. Problems move to content version 2. Older drafts can be exported or restored into the current workspace; older or imported solves require resubmission to verify.

Account submission and cloud-draft APIs require the existing configured authentication, database and rate-limit infrastructure. Guest practice remains available without account services. The server judge admits one runtime per process because Webernetes has a process-local log sink, returns a retryable busy response instead of sharing state, and bounds reconciliation time. This is a bounded simulation service; production capacity should be sized for the desired concurrent submission rate.

No production database migration or deployment is performed by this PR. Local database testing uses committed migrations on PGlite. External OAuth/provider login and a production load test require deployment-specific configuration and are not represented as completed by these tests.
