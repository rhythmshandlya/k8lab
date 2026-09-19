import type {
  KubernetesVersionRange,
  ProblemChallengeMode,
  ProblemPublicationStatus,
} from "@/lib/domain/types";

/**
 * Kubernetes supports the latest three minor releases. The catalog is reviewed
 * against 1.36 and currently accepts the active 1.34-1.36 line.
 */
export const CURRENT_KUBERNETES_RANGE: KubernetesVersionRange = {
  min: "1.34",
  max: "1.36",
  tested: "1.36",
};

export const PUBLISHED_PROBLEM_V1: {
  contentVersion: number;
  publicationStatus: ProblemPublicationStatus;
  challengeMode: ProblemChallengeMode;
  kubernetesVersion: KubernetesVersionRange;
} = {
  contentVersion: 2,
  publicationStatus: "published",
  challengeMode: "repair",
  kubernetesVersion: CURRENT_KUBERNETES_RANGE,
};
