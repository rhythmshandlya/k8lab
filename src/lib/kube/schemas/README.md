# Versioned Kubernetes schemas

These generated schemas are derived from the official, pinned releases listed in `sources.json` and `external-sources.json`. Each source includes its SHA-256 and Apache-2.0 license identifier. Kubernetes schemas cover 1.34.0, 1.35.0 and 1.36.0; the runtime uses 1.36 and qualification checks all three.

Regenerate with `node scripts/update-kubernetes-schemas.mjs` and `node scripts/update-crd-schemas.mjs`, then run the schema qualification, semantic, adversarial and full catalog tests. Review upstream changes before moving a pin. Generated JSON is intentionally compact and excluded from Prettier.

Schema checks validate API identities, required fields, types and unknown fields. Semantic checks additionally enforce the exercise's cross-resource contracts and supported Pod admission rules. These checks do not execute admission webhooks, CEL policies, cloud controllers or arbitrary container programs. Modelled incidents explicitly reject unsupported runtime-affecting changes; architecture results remain labelled static reviews. They are not a claim that a manifest was deployed into a real Kubernetes cluster.

The fictional Preview CRD and Kustomization authoring document have explicit local teaching contracts in `schema-validation.ts`. Kustomization is never inserted as a cluster API object.
