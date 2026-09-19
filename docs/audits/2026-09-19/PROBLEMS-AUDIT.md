**Problems production-readiness audit — Phase 1**

Date: 19 September 2026. Reviewed commit: `d53dda277c8e89999ce3ca01e780418f3ac0e0a3`.

**Verdict: hold public launch of Problems in its current form.** The application has a useful foundation, but its judge can accept incorrect solutions and its investigation tools sometimes conceal the incident. A passing test suite currently does not establish Kubernetes correctness. These issues directly undermine the product's promise of learning through accurate feedback.

This was a review, not a remediation pass. No production source was changed. The audit adds this report, executable observation probes, and result artifacts under `docs/audits/2026-09-19`. Existing untracked Docker configuration was left intact.

**What was exercised**

- Used the running production Docker application at `http://localhost:3000`, including guest entry, problem browsing, editing, apply, validation, solution feedback, terminal commands, Events, network sampling, architecture review, and a 390 × 844 viewport. Focused interactive investigations covered Service Selector Mismatch, All Replicas One Failure Domain, Graceful Shutdown 502s, Build a Three-Zone API, and The Conntrack Ghost. This was not a manual solve of every problem.
- Verified the running container's 324 `src` files matched the checkout before testing. Used its installed dependencies because the host checkout had no `node_modules`.
- Passed TypeScript checking and lint. Passed 444 existing tests across the level gate (101), remaining unit/component checks (285), API suite (54), and remaining integration checks (4). The level gate includes the canonical broken-to-fixed path across all 60 problems.
- Executed 197 provided quick commands across all 44 modelled/static problems without command execution failures. This checks availability, not semantic equivalence with real kubectl.
- Added targeted adversarial probes for false acceptance and a PGlite-backed progress persistence probe. Their results reproduce the defects below; the observational probes are not passing regression tests for the desired behavior.
- Ran the production dependency audit; it reports 2 critical, 1 high, and 3 moderate vulnerabilities and fails the configured high-severity gate.

The existing production build was reused; a fresh build, the repository Playwright suite, real Kubernetes cluster execution, live authenticated provider flow, external database deployment, load testing, and cross-browser qualification were **not** completed. API/database tests used the existing test environment. Initial React test failures caused by inheriting the production container's `NODE_ENV=production` disappeared when the unit/component tests were correctly rerun with `NODE_ENV=test`; they are not application defects.

**What “all problems work” currently means**

| Execution mode | Problems | Actual mechanism |
| --- | ---: | --- |
| Webernetes | 16 | Browser-side reconciliation simulator |
| Dedicated scripted scenario | 5 | Scenario-specific state and behavioral models |
| Fixture incident | 30 | Authored broken/healthy snapshots selected using manifest checks |
| Architecture build | 9 | Static manifest and relationship assessment |

The UI already discloses “Modelled incident” and “Static architecture review,” including that architecture review does not prove SLOs or failure scenarios. Those disclosures are good. Static exercises can be a valid part of the product. The launch issue is accepting invalid configurations or displaying a state contradicted by the submitted manifests. If every challenge is intended to demonstrate operational behavior, the nine static builds also need an execution layer before that broader promise is made.

**Prioritized findings**

P1 means fix before public launch or before exposing the affected competitive feature. P2 means a material learning, usability, or durability defect to resolve before calling Problems production complete. Evidence is distinguished as browser reproduction, automated probe, or code/specification review.

**1. P1 — Submission can pass against an old runtime while the editor contains a broken solution.**

Browser reproduction: solve Service Selector Mismatch by changing `app: web` to `app: web-app`, apply, and validate. Then restore `app: web` in the editor and run validation without applying. The app still reports “Incident resolved,” 5/5 checks. An independent engine probe reproduces it. In Build a Three-Zone API, applying the canonical solution and subsequently changing CPU requests to `"0"` without applying also passes submission, even though the semantic checker independently reports non-positive CPU.

The submit handler combines current editor files with the previous runtime. Formal validation runs authored constraints but does not rerun the general workspace semantic checks. There is no submitted-revision identity tying the files, runtime, report, and awarded progress together.

Code: [submit handler](C:/Users/armaa/Documents/k8lab/src/features/problems/components/level-workspace.tsx:362), [formal validation](C:/Users/armaa/Documents/k8lab/src/lib/kube/validators.ts:56).

Required outcome: one immutable submission revision must be parsed, schema-checked, semantically checked, applied/converged where appropriate, and graded. Either submission applies that revision or rejects unapplied edits clearly. Editing while checks run must not attach a result to newer files. Add regressions for both reproductions and equivalent behavior in every engine mode.

**2. P1 — Fixture incidents synthesize success despite manifests that make the claimed runtime impossible.**

Browser and engine reproduction: take the valid topology spread fix for All Replicas One Failure Domain, then add `spec.template.spec.nodeName: zone-a-1`. Apply and submit. The app reports success, awards 150 XP, and displays Pods distributed over zones A, B, and C. The explicit node pin contradicts that distribution. Kubernetes documents that a nonempty `nodeName` bypasses the scheduler and assigns the Pod to the named node. [Kubernetes node assignment documentation](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#nodename).

Additional probes pass a node selector for a nonexistent node and a container command that immediately exits, while still showing the authored healthy snapshot. The shared fixture engine controls 30 problems; these examples demonstrate a systemic blind spot, not proof that every possible solution to all 30 is broken.

Code: [fixture apply and state selection](C:/Users/armaa/Documents/k8lab/src/lib/kube/problem-engine.ts:290), especially the unconditional choice of `fixture.healthy` when selected constraints pass at line 318.

Required outcome: derive supported behavior from submitted objects, including conflicting scheduling and container fields; fail clearly on unsupported semantics. A deterministic educational model is acceptable, but it must not invent observations contradicted by its input. Where a model cannot establish the objective, grade it explicitly as a static review or use an isolated execution backend.

**3. P1 — The judge accepts manifests Kubernetes rejects.**

Automated probes pass all of these changes to otherwise canonical solutions: Deployment `restartPolicy: Never`; container port `70000`; a readiness probe declaring both `httpGet` and `exec`; and `privileged: true` in a namespace enforcing restricted Pod Security. Both the fixture and architecture paths accept the invalid Deployment restart policy. The parser establishes YAML/document identity but does not validate the full resource schema. Workspace checks implement a useful subset of semantics, leaving schema and admission holes.

Code: [manifest parser](C:/Users/armaa/Documents/k8lab/src/lib/kube/manifest-parser.ts:64), [workload checks](C:/Users/armaa/Documents/k8lab/src/lib/kube/workspace-semantics.ts:748).

Required outcome: validate built-in resources against the declared Kubernetes version's schemas, then apply relevant admission and cross-resource rules. Load explicit schemas for supported CRDs. Do not silently claim support for unknown resource semantics. Check reference manifests with a real API/server-side validation path in CI, including generated Pods for admission policies. Kubernetes only permits `Always` for a Deployment's restart policy. [Deployment documentation](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).

**4. P1 — At least two canonical architecture solutions violate their own restricted security policy.**

Code/specification review and automated extraction: Build a Three-Zone API and Build a Flash-Sale Scaling System create namespaces with `pod-security.kubernetes.io/enforce: restricted`, but their API/worker containers omit the required privilege escalation, dropped capabilities, non-root, and seccomp settings. Without an additional, unspecified mutating admission layer, the workload Pods would be rejected. This is not a real-cluster execution result; it follows from the supplied manifests and the published restricted policy. [Restricted Pod Security Standard](https://kubernetes.io/docs/concepts/security/pod-security-standards/).

The semantic checker applies the full hardening checks only when `semanticPolicy.podSecurity` is explicitly `hardened`; it does not infer the workload obligations from the namespace enforcement label.

Code: [three-zone canonical namespace and workload](C:/Users/armaa/Documents/k8lab/src/content/levels/architecture/build-three-zone-api.ts:42), [flash-sale canonical namespace and workloads](C:/Users/armaa/Documents/k8lab/src/content/levels/architecture/build-flash-sale-scaling-system.ts:49), [conditional hardening validation](C:/Users/armaa/Documents/k8lab/src/lib/kube/workspace-semantics.ts:807).

Required outcome: repair the canonical manifests and explanations, derive security requirements from actual namespace policies, and independently validate every canonical solution. Passing a rubric that encodes the same omission is not a sufficient content accuracy check.

**5. P1 — A no-op preStop hook is accepted as successful graceful draining.**

Automated reproduction in Graceful Shutdown 502s: replace the canonical preStop action with `exec: { command: ["true"] }`, retaining the qualifying grace period. Apply and validation both succeed. The goal checker accepts any nonempty command as a drain signal and treats unknown duration as zero. The scripted runtime uses this boolean to turn the incident healthy. Browser sampling of the initial incident correctly showed two 502s in six requests, so the inaccurate transition is material to the taught lesson.

An immediately returning `true` command neither asks the app to drain nor creates a delay for the stated failure. Kubernetes executes preStop before sending TERM. [Container lifecycle documentation](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/).

Code: [graceful drain goal](C:/Users/armaa/Documents/k8lab/src/lib/kube/goal-checks.ts:192), [scripted transition](C:/Users/armaa/Documents/k8lab/src/lib/kube/scripted-scenarios.ts:324).

Required outcome: model the supported drain actions and timing, or test the app behavior itself. No-op, unknown, unsuccessful, and over-budget hooks must not establish successful draining merely by being present; equivalent valid approaches should still pass.

**6. P1 — Investigation panels hide incident resources and events because of namespace assumptions.**

Browser reproduction: All Replicas One Failure Domain reports a warning in `payments`, but Events says “No events yet.” Running the supplied `kubectl get events -n payments` shows the warning. Events is hardcoded to `default`; 28 of the 30 fixture incidents use another namespace.

A second browser reproduction: The Conntrack Ghost's Cluster Explorer says “None” for every resource category even though its provided terminal command describes the existing `kube-system/coredns` Deployment. The shared namespace filter excludes every namespace beginning with `kube-`. Three fixture incidents are explicitly in `kube-system`, contrary to the comment that these namespaces are never part of a puzzle.

Code: [namespace exclusion](C:/Users/armaa/Documents/k8lab/src/features/problems/components/level-workspace.tsx:76), [workspace namespaces](C:/Users/armaa/Documents/k8lab/src/features/problems/components/level-workspace.tsx:441), [Events namespace](C:/Users/armaa/Documents/k8lab/src/features/problems/components/level-workspace.tsx:768), [event filtering](C:/Users/armaa/Documents/k8lab/src/components/events/events-timeline.tsx:28).

Required outcome: use the problem's declared namespaces or an explicit shared namespace selector, including relevant system namespaces. Terminal, events, logs, explorer, topology, and evidence collection must agree about the visible incident. Test at least one default, one application, and one system namespace incident end to end.

**7. P1 — Server progress accepts unverified success claims from the browser.**

PGlite-backed reproduction using the same parser and repository called by the authenticated route: submit a valid batch for its owning user containing a `solved` intent for Build a Three-Zone API without files or a validation result. It awards the catalog's 500 XP. The same batch stores `passed: true`, `checksPassed: 0`, `checksTotal: 1`, and accepts a solved date of `2099-01-01`.

Authentication and ownership checks exist; this is not an authentication bypass. The issue is that an authenticated learner can self-assert a solve. The server correctly controls the catalog XP amount but does not verify that the work was solved. Any rankings, qualification statistics, or achievement claims based on these rows inherit this weakness. The probe did not contact a live production account or database.

Code: [progress endpoint](C:/Users/armaa/Documents/k8lab/src/app/api/progress/route.ts:62), [solve persistence](C:/Users/armaa/Documents/k8lab/src/lib/db/progress-repo.ts:56), [submission persistence](C:/Users/armaa/Documents/k8lab/src/lib/db/progress-repo.ts:106), [input schema](C:/Users/armaa/Documents/k8lab/src/lib/storage/progress-intent.ts:44).

Required outcome: verify or replay submissions on the server, or consume a tamper-resistant result issued by a trusted judge and bound to user, problem version, and submitted revision. Keep guest/self-reported progress distinguishable from verified competitive records. Enforce result consistency and reasonable server-anchored dates.

**8. P1 — The configured dependency security gate fails on the locked production dependency set.**

The audit reports two critical, one high, and three moderate vulnerabilities. The lock contains Next `16.3.0` and sharp `0.35.3`. Current maintainer advisories identify patched versions Next `16.3.3` and sharp `0.35.4` for the relevant RCE/libheif issues. [Next image optimization advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4), [sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c), [Windows-hosted Next advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36).

Exposure is conditional: the Windows issue does not apply to the reviewed Linux container; the image issues depend on the affected image processing path and untrusted input. No exploit was attempted or established. The failing release gate and affected locked versions are confirmed.

Code: [locked Next](C:/Users/armaa/Documents/k8lab/pnpm-lock.yaml:4479), [locked sharp](C:/Users/armaa/Documents/k8lab/pnpm-lock.yaml:4986). Evidence: [dependency audit JSON](C:/Users/armaa/Documents/k8lab/docs/audits/2026-09-19/security-results.json).

Required outcome: update to patched compatible versions, refresh the lock, rerun the dependency audit and production build, and verify the deployment's actual runtime/image processing configuration.

**9. P2 — Architecture tasks require arbitrary exact values that the brief does not reveal.**

Browser/code reproduction: Build a Three-Zone API starts `namespace.yaml` with two comments telling the learner to author an owned restricted namespace. Acceptance nevertheless requires the exact namespace `resilient-api`, owner `checkout-platform`, and custom label `securityProfile: restricted`. Those values are absent from the visible problem contract before attempting a submission. Similar exact resource identities are generated for architecture files. A reasonable design using another owner or name fails for a requirement the learner was never given.

Code: [hidden exact values](C:/Users/armaa/Documents/k8lab/src/content/levels/architecture/build-three-zone-api.ts:42), [comment-only starter](C:/Users/armaa/Documents/k8lab/src/content/levels/architecture/spec.ts:113), [generated identity constraints](C:/Users/armaa/Documents/k8lab/src/content/levels/architecture/spec.ts:119).

Required outcome: publish the full input/output contract, required identities, environmental assumptions, and required metadata. Provide skeletons where literal names are mandatory. Withhold the solution mechanism, not arbitrary contract values; accept equivalent valid configurations when the identity is immaterial.

**10. P2 — Unsupported kubectl flags are silently ignored and teach incorrect command behavior.**

Automated reproductions: `kubectl get pods -o json` succeeds with a plain table. `kubectl get pods --field-selector=status.phase=Pending` succeeds while returning two Running Pods. The argument parser consumes or overlooks unsupported options without rejecting the request.

Code: [argument parser](C:/Users/armaa/Documents/k8lab/src/lib/kube/command-runner.ts:197).

Required outcome: implement the advertised flag semantics or return an explicit unsupported-option error with the supported alternative. A limited teaching shell is reasonable; silently producing incorrect results is not. Add parser and output checks for supported and unsupported combinations.

**11. P2 — Switching investigation tabs deletes terminal output and command history.**

Browser reproduction: run the incident's events command, switch to Events, then return to Terminal. The terminal is recreated at its welcome message and prompt; the prior command and output disappear. Investigation depends on comparing output between tools, so this interrupts the central workflow.

Code: [conditional terminal mount](C:/Users/armaa/Documents/k8lab/src/features/problems/components/level-workspace.tsx:742), [component-owned history](C:/Users/armaa/Documents/k8lab/src/components/terminal/xterm-terminal.tsx:97), [terminal disposal](C:/Users/armaa/Documents/k8lab/src/components/terminal/xterm-terminal.tsx:212).

Required outcome: retain the terminal instance while changing tabs or restore scrollback and command history from per-problem session state. Add an interaction regression that compares the transcript and history before and after tab switching.

**12. P2 — The workspace is not usable as a responsive learning interface.**

Browser reproduction at 390 × 844: the left incident rail dominates the viewport; the editor, submit controls, and inspector require panning across a workspace at least 1080 pixels wide. The primary navigation is hidden below `md` without an equivalent mobile navigation menu. The problem is awkward access to core actions, not simply a cosmetic overflow.

Code: [workspace minimum width](C:/Users/armaa/Documents/k8lab/src/features/problems/components/level-workspace.tsx:492), [hidden primary navigation](C:/Users/armaa/Documents/k8lab/src/components/app-shell/top-nav.tsx:30).

Required outcome: provide a stacked/tabbed compact workspace and discoverable navigation, or explicitly scope the editing experience to supported desktop widths while retaining useful narrow-screen browsing. Verify 390, 768, and common laptop widths, zoom, keyboard navigation, focus visibility, and access to every primary action.

**13. P2 — Submissions do not retain the submitted files, detailed report, or content version.**

Code review: the UI submits pass/fail, counts, duration, and hint count, but omits its files and validator results. The database's optional `results` field is described as holding a full replay snapshot yet is normally left null. Solves are keyed by user and slug without the problem content version. This prevents reliable solution history, reproduction of a disputed grade, or distinguishing old solves from a changed exercise.

Code: [submission payload](C:/Users/armaa/Documents/k8lab/src/features/problems/components/level-workspace.tsx:378), [solve identity](C:/Users/armaa/Documents/k8lab/src/lib/db/schema.ts:99), [submission schema](C:/Users/armaa/Documents/k8lab/src/lib/db/schema.ts:165).

Required outcome: store immutable files, problem/content version, engine/judge version, full verdict, timestamps, and submitted revision identity; provide a learner-visible history/reopen path. Versioning needs an explicit policy for whether changed exercises retain, invalidate, or label previous completion.

**14. P2 — Draft durability has silent loss and account-isolation gaps.**

Code review: problem drafts are localStorage-only and keyed by problem slug, without user identity. A different account in the same browser can inherit the previous account's draft. Only 40 drafts are retained in a 60-problem catalog; older drafts are silently pruned. A content-version mismatch makes a saved draft unreadable by the loader. Storage quota failures are swallowed, and pruning is only attempted after a successful write, so a full store is not reclaimed before retrying the failed save.

Code: [draft key and retention](C:/Users/armaa/Documents/k8lab/src/lib/storage/level-workspace.ts:14), [version mismatch](C:/Users/armaa/Documents/k8lab/src/lib/storage/level-workspace.ts:35), [write and pruning](C:/Users/armaa/Documents/k8lab/src/lib/storage/level-workspace.ts:64).

These are deterministic code paths; a live account-switch, browser quota exhaustion, and multi-device session were not exercised.

Required outcome: scope drafts to identity, show saved/saving/failed status, offer recovery or export, migrate or preserve old-version work, and use an explicit retention policy. Authenticated learners need durable server-backed drafts if cross-device continuation is part of the product promise.

**15. P2 — The displayed current streak can remain positive years after activity stopped.**

Automated reproduction: `deriveStreak(["2020-01-01", "2020-01-02"])` returns `streakDays: 2` today. It calculates the consecutive run ending at the latest recorded day without checking whether that day is today or yesterday. The navigation displays this number as the current day streak. The local progress path similarly persists the counter until another newly solved problem changes it.

Code: [server derivation](C:/Users/armaa/Documents/k8lab/src/lib/db/progress-repo.ts:215), [display](C:/Users/armaa/Documents/k8lab/src/components/app-shell/top-nav.tsx:51).

Required outcome: define the learner's calendar/timezone policy and calculate an active streak relative to the current day. Keep historical best streak separate. Clarify whether re-solving an old exercise counts as daily activity, independently of one-time XP.

**16. P1 — Release qualification does not independently establish the accuracy or full user journey of all 60 problems.**

The passing level gate is valuable: all canonical solutions can move their configured engines from failing to passing. There are also existing negative, content integrity, relationship, and alternative-solution checks. However, both the fixtures and their validators share authored assumptions, so a green result can be self-consistent while Kubernetes behavior is wrong, as findings 2–5 demonstrate.

The inspected Problems browser suite includes one complete reference solve, plus access/rendering and empty-submission checks. It does not establish all 60 editor → apply → investigate → submit → persist → reopen paths. The static architecture test explicitly asserts that operational SLOs are not proven. The browser suite was inspected, not run during this audit.

Code: [reference browser solve](C:/Users/armaa/Documents/k8lab/src/tests/e2e/broken-readiness-probe.spec.ts:8), [curriculum smoke checks](C:/Users/armaa/Documents/k8lab/src/tests/e2e/problem-curriculum.spec.ts:5), [level gate definition](C:/Users/armaa/Documents/k8lab/vitest.levels.config.ts:9).

Required outcome: use an independent Kubernetes schema/admission/behavior oracle for reference content, and a catalog-wide exercise qualification matrix. Each problem needs a reproducible initial failure, observable clues, at least one valid solution, relevant invalid near-solutions, equivalent valid alternatives where supported, reset/reopen coverage, and truthful limitations. Add authenticated browser persistence and failure recovery checks for the shared workflow. A test that only checks the same fixture against the same rubric cannot certify the real concept being taught.

**Implementation order**

1. Establish the submitted-revision contract and a trusted validation pipeline; address findings 1, 3, 7, and 13 together. Patch affected dependencies as a separate immediate change.
2. Fix the independent content/model errors in findings 2, 4, and 5, and qualify every published problem against the declared support contract. Keep static and operational achievements explicit.
3. Repair investigation visibility, required problem contracts, terminal continuity, and command fidelity. These determine whether a learner can diagnose and understand the incident.
4. Complete responsive behavior, durable account-scoped drafts, accurate progress, and catalog-wide release qualification.

**Production exit criteria**

- All confirmed P1 findings are closed with regressions that would have failed on the reviewed revision. P2 items are fixed or explicitly excluded from the published support contract with usable alternatives.
- Every published problem passes a versioned qualification record covering content accuracy, broken state, clues, accepted solutions, rejected near-solutions, and supported engine limitations.
- Submission files, runtime, verdict, and persisted progress refer to the same revision; competitive success is independently verified.
- Real Kubernetes validation confirms built-in API/schema/admission claims; scenario-specific behavioral claims have an independent check or are explicitly scoped as static review.
- The full production verification pipeline, security audit, fresh production build, shared browser flows, and a catalog-wide Problems exercise matrix pass. Qualify the actual authenticated deployment and database migration/recovery path separately.
- Browser storage failure, interrupted apply/submit, reload, reset, account switching, network failure, supported viewport sizes, and keyboard use have defined recoverable behavior.

This audit does not certify production readiness after an unspecified future change. These exit criteria define what the remediation phase must demonstrate.

**Evidence and reproduction artifacts**

- [Problem engine and content observations](C:/Users/armaa/Documents/k8lab/docs/audits/2026-09-19/probe-results.json)
- [Progress persistence observations](C:/Users/armaa/Documents/k8lab/docs/audits/2026-09-19/progress-results.json)
- [Problem probe source](C:/Users/armaa/Documents/k8lab/docs/audits/2026-09-19/problems-probes.test.ts.txt)
- [Progress probe source](C:/Users/armaa/Documents/k8lab/docs/audits/2026-09-19/progress-probes.test.ts.txt)
- [Verification summary](C:/Users/armaa/Documents/k8lab/docs/audits/2026-09-19/verification.json)
- [Remaining unit/component test results](C:/Users/armaa/Documents/k8lab/docs/audits/2026-09-19/unit-results.json)
- [Remaining integration test results](C:/Users/armaa/Documents/k8lab/docs/audits/2026-09-19/integration-results.json)

To rerun the observation probes in an installed checkout, copy `problems-probes.test.ts.txt` into `src/tests/unit/phase1-audit.test.ts` and `progress-probes.test.ts.txt` into `src/tests/api/phase1-progress.test.ts`. Run the former with the default Vitest configuration and the latter with `vitest.api.config.ts`, with `NODE_ENV=test`. They write JSON into `/tmp`; adjust those output paths on a native Windows run. Remove the temporary copies afterward. The probes deliberately observe current acceptance behavior and must be converted into assertions of the corrected behavior when implementing fixes.
