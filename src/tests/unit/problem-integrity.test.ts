import { describe, expect, it } from "vitest";

import { LEVELS } from "@/content/levels";
import { LEVEL_VARIANTS } from "@/content/levels/alternatives";
import { LEVEL_SOLUTIONS } from "@/content/levels/solutions";
import type { ProblemLevel } from "@/lib/domain/types";
import { createProbeSignal, matchEvidence, type InvestigationSignal } from "@/lib/kube/evidence";
import { evaluateLevelConstraints } from "@/lib/kube/manifest-constraints";
import { parseKubernetesManifests, stringifyManifest } from "@/lib/kube/manifest-parser";
import { createProblemEngine, type ProblemEngine } from "@/lib/kube/problem-engine";
import { resolveQuickCommand } from "@/lib/kube/quick-command";
import { evaluateWorkspaceSemantics } from "@/lib/kube/workspace-semantics";

/**
 * Integrity gates for the problem catalog. These check properties that the
 * red-green solvability suite structurally cannot see: that the free feedback
 * surface never states the answer, that every piece of authored evidence is
 * actually collectable, and that levels do not collapse onto one shared
 * investigation experience.
 */

function workspaceFiles(level: ProblemLevel): Record<string, string> {
  return Object.fromEntries(
    level.files
      .filter((file) => file.access !== "hidden")
      .map((file) => [file.path, file.initialValue]),
  );
}

/** Scripted scenarios and fixtures run synchronously; a Webernetes boot does not. */
function isScripted(level: ProblemLevel): boolean {
  return level.engine.kind === "scripted" || level.engine.kind === "fixture";
}

describe("no free answers", () => {
  /**
   * The always-visible "Failing checks" panel renders `detail` before the learner
   * submits anything, so generated feedback may never name the field to change or the
   * value to set. Only *unmet* requirements are answers; a value the starting manifest
   * already satisfies is part of the scenario, not the fix. The resource's own
   * identity is excluded too: a build level cannot state its assignment without
   * naming the resource it asks for.
   */
  it("pre-submission check details never state an unmet requirement's path or value", () => {
    const leaks: string[] = [];

    for (const level of LEVELS) {
      const files = workspaceFiles(level);
      const results = evaluateLevelConstraints(level, files);
      const answers = unmetRequirements(level, files);

      for (const result of results) {
        for (const path of answers.paths) {
          if (result.detail.includes(path)) {
            leaks.push(`${level.slug}: detail names path ${path}`);
          }
        }
        for (const value of answers.values) {
          if (result.detail.includes(value)) {
            leaks.push(`${level.slug}: detail states value ${value}`);
          }
        }
      }
    }

    expect(leaks.slice(0, 20)).toEqual([]);
  });

  /**
   * The same generated text reaches the learner through the scripted scenario's
   * rejection event and policy-engine log, which are read for free on the Events and
   * Logs tabs. De-leaking the panel and leaving those wide open would fix nothing.
   */
  it("scripted rejection events and logs never state an unmet requirement", async () => {
    const leaks: string[] = [];

    for (const level of LEVELS.filter(isScripted)) {
      const files = workspaceFiles(level);
      const answers = unmetRequirements(level, files);
      const engine = createProblemEngine(level.engine);
      try {
        await engine.boot(level);
        await engine.applyFiles(files);
        const snapshot = engine.getSnapshot();
        const surfaces = [
          ...snapshot.events.map((event) => event.message ?? ""),
          ...snapshot.pods.flatMap((pod) =>
            engine
              .getLogs(pod.metadata?.namespace ?? "default", pod.metadata?.name ?? "")
              .map((line) => line.message),
          ),
        ];
        for (const surface of surfaces) {
          for (const path of answers.paths) {
            if (surface.includes(path)) leaks.push(`${level.slug}: event/log names path ${path}`);
          }
          for (const value of answers.values) {
            if (surface.includes(value)) leaks.push(`${level.slug}: event/log states ${value}`);
          }
        }
      } finally {
        await engine.close();
      }
    }

    expect(leaks.slice(0, 20)).toEqual([]);
  });
});

/** The paths and literals that constitute the answer, given where the learner starts. */
function unmetRequirements(
  level: ProblemLevel,
  files: Readonly<Record<string, string>>,
): { paths: string[]; values: string[] } {
  const paths: string[] = [];
  const values: string[] = [];
  const given = visibleIdentities(level);

  for (const constraint of level.constraints) {
    if (constraint.kind !== "manifest") continue;
    given.add(constraint.resource.kind);
    given.add(constraint.resource.name);
    if (constraint.resource.namespace) given.add(constraint.resource.namespace);

    const diagnostic = failingDiagnostic(level, constraint.id, files);
    for (const assertion of constraint.assertions) {
      if (!diagnostic.includes(assertion.path)) continue;
      paths.push(assertion.path);
      if ("value" in assertion) values.push(String(assertion.value));
    }
  }

  // Words the brief already uses are the author's own language, not disclosure: an
  // RBAC verb like "update" is both a rubric value and an ordinary English word.
  // Build assignments publish their required literals in the starter contract.
  const contract =
    level.challengeMode === "build"
      ? level.files
          .filter((file) => file.access !== "hidden")
          .map((file) => file.initialValue)
          .join("\n")
      : "";
  const authored = `${level.story} ${level.objective} ${level.blurb} ${contract}`.toLowerCase();

  return {
    paths,
    // Short literals ("1", "api") collide with counts and ordinary prose; only
    // distinctive strings are evidence of a leak rather than a coincidence.
    values: values.filter(
      (value) => value.length >= 4 && !given.has(value) && !authored.includes(value.toLowerCase()),
    ),
  };
}

/**
 * Names the learner can already read in their own workspace. A readonly Secret the
 * level ships is scenario material, not the answer: naming it in an event is exactly
 * what a real cluster does, and what makes the incident investigable.
 */
function visibleIdentities(level: ProblemLevel): Set<string> {
  const names = new Set<string>();
  for (const file of level.files) {
    if (file.access === "hidden") continue;
    const parsed = parseKubernetesManifests(file.initialValue);
    if (!parsed.ok) continue;
    for (const manifest of parsed.value) {
      names.add(manifest.kind);
      names.add(manifest.name);
      names.add(manifest.namespace);
    }
  }
  return names;
}

/** Which assertions are currently unmet, read back out of the prescriptive breakdown. */
function failingDiagnostic(
  level: ProblemLevel,
  constraintId: string,
  files: Readonly<Record<string, string>>,
): string {
  const result = evaluateLevelConstraints(level, files).find(
    (candidate) => candidate.id === `constraint:${constraintId}`,
  );
  return result?.passed ? "" : (result?.diagnostic ?? "");
}

describe("evidence reachability", () => {
  it("every validator-triggered rule points at a check the level actually runs", () => {
    const dangling: string[] = [];
    for (const level of LEVELS) {
      const ids = new Set([
        ...level.validators.map((validator) => validator.id),
        ...level.constraints.map((constraint) => `constraint:${constraint.id}`),
      ]);
      for (const rule of level.evidenceRules) {
        if (rule.trigger.type !== "validator") continue;
        if (!ids.has(rule.trigger.validatorId)) {
          dangling.push(`${level.slug}/${rule.id} -> ${rule.trigger.validatorId}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  /**
   * The bug this catches: an evidence rule whose trigger no signal can ever match
   * (a message pattern the scenario never emits, a pod name that does not exist).
   * Because deeper hints are gated on evidence, an unreachable rule silently locks a
   * hint tier forever. Structural authoring checks cannot see it; only replaying the
   * signals the engine actually produces can.
   */
  it("every scripted level's evidence is collectable from its broken state", async () => {
    const unreachable: string[] = [];

    for (const level of LEVELS.filter(isScripted)) {
      const engine = createProblemEngine(level.engine);
      try {
        const booted = await engine.boot(level);
        expect(booted.ok, `${level.slug} failed to boot`).toBe(true);
        // The learner's first action is Apply; evidence must be reachable after it.
        await engine.applyFiles(workspaceFiles(level));

        const signals = await collectAllSignals(engine, level);
        const collected = new Set(matchEvidence(level.evidenceRules, signals));
        for (const rule of level.evidenceRules) {
          if (!collected.has(rule.evidenceId)) {
            unreachable.push(`${level.slug}/${rule.id} (${rule.source})`);
          }
        }
      } finally {
        await engine.close();
      }
    }

    expect(unreachable).toEqual([]);
  });
});

describe("fixture command reachability", () => {
  it("every fixture quick command resolves and executes against an authored object", async () => {
    const broken: string[] = [];
    for (const level of LEVELS.filter((candidate) => candidate.engine.kind === "fixture")) {
      const engine = createProblemEngine(level.engine);
      try {
        await engine.boot(level);
        const snapshot = engine.getSnapshot();
        for (const quickCommand of level.quickCommands) {
          const line = resolveQuickCommand(quickCommand, snapshot.pods);
          if (!line) {
            broken.push(`${level.slug}/${quickCommand.id}: target did not resolve`);
            continue;
          }
          const result = await engine.runCommand(line, "default", workspaceFiles(level));
          if (
            result.isError ||
            /not found|No resources found|unsupported|not available/i.test(result.output)
          ) {
            broken.push(`${level.slug}/${quickCommand.id}: ${result.output}`);
          }
        }
      } finally {
        await engine.close();
      }
    }

    expect(broken).toEqual([]);
  });
});

/** Everything a diligent learner could surface without guessing: the whole surface. */
async function collectAllSignals(
  engine: ProblemEngine,
  level: ProblemLevel,
): Promise<InvestigationSignal[]> {
  const snapshot = engine.getSnapshot();
  const signals: InvestigationSignal[] = [];

  for (const event of snapshot.events) {
    signals.push({
      type: "event-reason",
      reason: event.reason ?? "",
      message: event.message ?? "",
      namespace: event.metadata?.namespace ?? "default",
    });
  }

  for (const pod of snapshot.pods) {
    const namespace = pod.metadata?.namespace ?? "default";
    const name = pod.metadata?.name;
    if (!name) continue;
    for (const line of engine.getLogs(namespace, name)) {
      signals.push({
        type: "log",
        namespace: line.namespace,
        pod: line.pod,
        message: line.message,
      });
    }
  }

  const objects = [
    ...snapshot.pods.map((item) => ["Pod", item] as const),
    ...snapshot.services.map((item) => ["Service", item] as const),
    ...snapshot.deployments.map((item) => ["Deployment", item] as const),
    ...snapshot.replicaSets.map((item) => ["ReplicaSet", item] as const),
    ...(snapshot.resources ?? []).map((item) => [item.kind, item] as const),
  ];
  for (const [kind, object] of objects) {
    const name = object.metadata?.name;
    if (!name) continue;
    const namespace = object.metadata?.namespace ?? "default";
    signals.push({ type: "object-view", kind, name, namespace });
    signals.push({ type: "topology-view", kind, name, namespace });
  }

  // Some incidents are intermittent by design (a rollout drops one request in three),
  // so a single probe is not the surface a learner actually has.
  const PROBES_PER_TARGET = 4;
  for (const target of level.probeTargets) {
    for (let attempt = 0; attempt < PROBES_PER_TARGET; attempt += 1) {
      signals.push(createProbeSignal(target, await engine.probe(target)));
    }
  }

  for (const quickCommand of level.quickCommands) {
    const line = resolveQuickCommand(quickCommand, snapshot.pods);
    if (!line) continue;
    const result = await engine.runCommand(line, "default", workspaceFiles(level));
    signals.push({ type: "command", command: line, output: result.output });
  }

  for (const validator of await engine
    .validate(level, workspaceFiles(level))
    .then((r) => r.results)) {
    signals.push({
      type: "validator",
      validatorId: validator.id,
      passed: validator.passed,
      detail: validator.detail,
    });
  }

  return signals;
}

describe("position independence", () => {
  /**
   * Kubernetes identifies most list entries by key, not position: a container is
   * "the one named api" whether it is first or third. A rubric that pins
   * `containers.0` rejects a correct manifest the moment the learner adds a sidecar
   * above the app container. Reordering a keyed list must not change the verdict.
   */
  it("reordering a keyed list never changes a canonical solution's verdict", () => {
    const regressions: string[] = [];

    for (const level of LEVELS) {
      const solution = LEVEL_SOLUTIONS[level.slug];
      if (!solution) continue;
      const files = { ...workspaceFiles(level), ...solution.files };

      for (const constraint of level.constraints) {
        if (constraint.kind !== "manifest") continue;
        const listPaths = new Set(
          constraint.assertions.flatMap((assertion) => keyedListPrefixes(assertion.path)),
        );
        if (listPaths.size === 0) continue;

        const source = files[constraint.file];
        if (source === undefined) continue;
        const parsed = parseKubernetesManifests(source);
        if (!parsed.ok) continue;

        const shuffled = structuredClone(parsed.value.map((manifest) => manifest.raw));
        let reordered = false;
        for (const document of shuffled) {
          for (const listPath of listPaths) {
            const list = valueAtDotPath(document, listPath);
            if (Array.isArray(list) && list.length > 1) {
              list.reverse();
              reordered = true;
            }
          }
        }
        if (!reordered) continue;

        const verdict = evaluateLevelConstraints(level, {
          ...files,
          [constraint.file]: shuffled.map((document) => stringifyManifest(document)).join("---\n"),
        }).find((result) => result.id === `constraint:${constraint.id}`);

        if (verdict && !verdict.passed) {
          regressions.push(
            `${level.slug}/${constraint.id}: ${verdict.diagnostic ?? verdict.detail}`,
          );
        }
      }
    }

    expect(regressions).toEqual([]);
  });
});

/** Dot-paths of every list a `[field=value]` selector addresses. */
function keyedListPrefixes(path: string): string[] {
  const prefixes: string[] = [];
  const parts = path.split(".");
  const walked: string[] = [];
  for (const part of parts) {
    const selector = /^([^[\]]+)\[[^=\]]+=[^\]]*\]$/.exec(part);
    if (selector) {
      prefixes.push([...walked, selector[1]!].join("."));
      walked.push(part);
      continue;
    }
    walked.push(part);
  }
  return prefixes;
}

function valueAtDotPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
  }, root);
}

describe("adversarial corpus", () => {
  /**
   * A level that only accepts the reference answer is grading transcription. These are
   * genuinely correct submissions written a different way, and they have to pass.
   */
  it("accepts every alternative correct solution", () => {
    const rejections: string[] = [];

    for (const [slug, variants] of Object.entries(LEVEL_VARIANTS)) {
      const level = LEVELS.find((candidate) => candidate.slug === slug);
      expect(level, `${slug} is not in the catalog`).toBeDefined();
      if (!level) continue;

      for (const variant of variants.accepted) {
        const files = { ...workspaceFiles(level), ...variant.files };
        const failing = [
          ...evaluateLevelConstraints(level, files)
            .filter((result) => !result.passed)
            .map((result) => result.diagnostic ?? result.detail),
          ...evaluateWorkspaceSemantics(level, files),
        ];
        if (failing.length > 0) {
          rejections.push(`${slug}: "${variant.reason}" was rejected — ${failing[0]}`);
        }
      }
    }

    expect(rejections).toEqual([]);
  });

  /**
   * The mirror image: plausible edits that do not actually fix the incident. A level
   * that accepts one of these teaches the wrong lesson and reports a false solve.
   */
  it("rejects every near-miss that does not fix the incident", () => {
    const falsePositives: string[] = [];

    for (const [slug, variants] of Object.entries(LEVEL_VARIANTS)) {
      const level = LEVELS.find((candidate) => candidate.slug === slug);
      if (!level) continue;
      expect(
        variants.rejected.length,
        `${slug} needs at least two near-misses`,
      ).toBeGreaterThanOrEqual(2);

      for (const variant of variants.rejected) {
        const files = { ...workspaceFiles(level), ...variant.files };
        const failing = [
          ...evaluateLevelConstraints(level, files).filter((result) => !result.passed),
          ...evaluateWorkspaceSemantics(level, files),
        ];
        if (failing.length === 0) {
          falsePositives.push(`${slug}: "${variant.reason}" was accepted`);
        }
      }
    }

    expect(falsePositives).toEqual([]);
  });
});

describe("catalog distinctness", () => {
  /**
   * A level is defined by what the learner can investigate, not by its prose. When
   * two levels share a fingerprint they are the same puzzle with different copy.
   * This floor ratchets up as levels get their own scenarios; it must never fall.
   */
  const MINIMUM_DISTINCT_FINGERPRINTS = 52;

  it("levels do not collapse onto a shared investigation surface", () => {
    const fingerprints = new Map<string, string[]>();
    for (const level of LEVELS) {
      const fingerprint = JSON.stringify([
        level.engine,
        level.quickCommands.map((command) => command.command),
        level.probeTargets,
        level.evidenceRules.map((rule) => rule.trigger),
        level.validators.map((validator) => [validator.kind, validator.id]),
      ]);
      fingerprints.set(fingerprint, [...(fingerprints.get(fingerprint) ?? []), level.slug]);
    }

    expect(fingerprints.size).toBeGreaterThanOrEqual(MINIMUM_DISTINCT_FINGERPRINTS);
  });
});
