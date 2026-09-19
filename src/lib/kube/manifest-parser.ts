import { dump, loadAll, YAMLException } from "js-yaml";

import { err, ok, type Result } from "@/lib/utils/result";

/**
 * Parses Kubernetes YAML (multi-document, `---`-separated) into lightweight typed
 * manifests. Deliberately independent of Webernetes: the simulator casts these to
 * its apply type at the boundary. Validation here is structural (kind/apiVersion/
 * name); Webernetes performs the deep spec validation when the manifest is applied.
 *
 * Returns a Result so callers (terminal, apply button) can show a helpful message
 * instead of crashing on malformed input.
 */

/** The object kinds klab's simulator can apply. */
export const SUPPORTED_KINDS = [
  "Deployment",
  "ReplicaSet",
  "Namespace",
  "Node",
  "Pod",
  "Service",
] as const;

export type SupportedKind = (typeof SUPPORTED_KINDS)[number];

function isSupportedKind(kind: string): kind is SupportedKind {
  return (SUPPORTED_KINDS as readonly string[]).includes(kind);
}

export interface ParsedManifest {
  apiVersion: string;
  kind: SupportedKind;
  name: string;
  namespace: string;
  /** The full parsed object, passed through to the simulator's apply(). */
  raw: Record<string, unknown>;
}

/**
 * A structurally valid Kubernetes object that may use an API the in-browser
 * control plane cannot execute. Policy and architecture labs use this wider form
 * so resources such as HPAs, PDBs, NetworkPolicies, and CRDs can still be assessed.
 */
export interface ParsedKubernetesManifest {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
  raw: Record<string, unknown>;
}

export interface ManifestParseError {
  message: string;
  /** 0-based index of the offending document within a multi-doc file, when known. */
  documentIndex?: number;
  line?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseKubernetesManifests(
  yamlText: string,
): Result<ParsedKubernetesManifest[], ManifestParseError> {
  if (yamlText.trim() === "") {
    return ok([]);
  }
  if (yamlText.length > 100_000) return err({ message: "A manifest file must not exceed 100 KB." });

  let documents: unknown[];
  try {
    documents = loadAll(yamlText);
    let nodes = 0;
    const ancestors = new Set<object>();
    const check = (value: unknown, depth: number): void => {
      if (++nodes > 50_000 || depth > 64)
        throw new Error("Manifest exceeds the supported nesting or object size limit");
      if (value === null || typeof value !== "object") return;
      if (ancestors.has(value))
        throw new Error("Recursive YAML aliases are not valid Kubernetes JSON");
      ancestors.add(value);
      for (const child of Object.values(value)) check(child, depth + 1);
      ancestors.delete(value);
    };
    if (documents.length > 100) throw new Error("At most 100 documents are supported per file");
    check(documents, 0);
  } catch (error) {
    if (error instanceof YAMLException) {
      return err({
        message: `YAML syntax error: ${error.reason ?? error.message}`,
        line: error.mark?.line !== undefined ? error.mark.line + 1 : undefined,
      });
    }
    return err({ message: `Failed to parse YAML: ${(error as Error).message}` });
  }

  const manifests: ParsedKubernetesManifest[] = [];

  for (let index = 0; index < documents.length; index++) {
    const doc = documents[index];
    // Empty documents (e.g. trailing `---`) parse to null/undefined: skip them.
    if (doc === null || doc === undefined) {
      continue;
    }
    if (!isPlainObject(doc)) {
      return err({
        message: `Document ${index + 1} is not a Kubernetes object (got ${Array.isArray(doc) ? "a list" : typeof doc}).`,
        documentIndex: index,
      });
    }

    const kind = doc.kind;
    if (typeof kind !== "string" || kind === "") {
      return err({
        message: `Document ${index + 1} is missing a "kind" field.`,
        documentIndex: index,
      });
    }
    const apiVersion = doc.apiVersion;
    if (typeof apiVersion !== "string" || apiVersion === "") {
      return err({
        message: `${kind} is missing an "apiVersion" field.`,
        documentIndex: index,
      });
    }

    const metadata = isPlainObject(doc.metadata) ? doc.metadata : undefined;
    const name =
      metadata?.name ??
      (kind === "Kustomization" && apiVersion === "kustomize.config.k8s.io/v1beta1"
        ? "kustomization"
        : undefined);
    if (typeof name !== "string" || name === "") {
      return err({
        message: `${kind} is missing "metadata.name".`,
        documentIndex: index,
      });
    }

    const namespace =
      typeof metadata?.namespace === "string" && metadata.namespace !== ""
        ? metadata.namespace
        : "default";

    manifests.push({ apiVersion, kind, name, namespace, raw: doc });
  }

  return ok(manifests);
}

/** Parse manifests that the live in-browser simulator can execute. */
export function parseManifests(yamlText: string): Result<ParsedManifest[], ManifestParseError> {
  const parsed = parseKubernetesManifests(yamlText);
  if (!parsed.ok) return parsed;

  const manifests: ParsedManifest[] = [];
  for (const [index, manifest] of parsed.value.entries()) {
    if (!isSupportedKind(manifest.kind)) {
      return err({
        message: `Unsupported kind "${manifest.kind}". The simulator supports: ${SUPPORTED_KINDS.join(", ")}.`,
        documentIndex: index,
      });
    }
    manifests.push({
      apiVersion: manifest.apiVersion,
      kind: manifest.kind,
      name: manifest.name,
      namespace: manifest.namespace,
      raw: manifest.raw,
    });
  }
  return ok(manifests);
}

/** Serialize an object back to canonical YAML (used for object-explorer YAML views). */
export function stringifyManifest(object: unknown): string {
  return dump(object, { indent: 2, lineWidth: 100, sortKeys: false, noRefs: true });
}
