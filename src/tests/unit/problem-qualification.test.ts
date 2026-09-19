import { describe, expect, it } from "vitest";
import { LEVELS } from "@/content/levels";
import { LEVEL_SOLUTIONS } from "@/content/levels/solutions";
import { evaluateWorkspaceSemantics } from "@/lib/kube/workspace-semantics";
import { createSchemaValidator } from "@/lib/kube/schema-validation";
import { parseKubernetesManifests } from "@/lib/kube/manifest-parser";
import v134 from "@/lib/kube/schemas/kubernetes-1.34.json";
import v135 from "@/lib/kube/schemas/kubernetes-1.35.json";
import v136 from "@/lib/kube/schemas/kubernetes-1.36.json";

describe("independent versioned schema qualification", () => {
  for (const bundle of [v134, v135, v136]) {
    const validate = createSchemaValidator(bundle);
    it.each(LEVELS)(`${bundle.version}: $slug reference is Kubernetes-valid`, (level) => {
      const files = {
        ...Object.fromEntries(level.files.map((file) => [file.path, file.initialValue])),
        ...LEVEL_SOLUTIONS[level.slug]!.files,
      };
      const errors: string[] = [];
      for (const [path, source] of Object.entries(files)) {
        const parsed = parseKubernetesManifests(source);
        if (!parsed.ok) {
          errors.push(`${path}: ${parsed.error.message}`);
          continue;
        }
        for (const resource of parsed.value)
          errors.push(...validate(resource).map((message) => `${path}: ${message}`));
      }
      expect(errors).toEqual([]);
      expect(evaluateWorkspaceSemantics(level, files)).toEqual([]);
    });
  }
});
