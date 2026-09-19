import type { ProblemLevel } from "@/lib/domain/types";

/** A stable, lossless identity; no hash collisions and no dependence on object order. */
export function workspaceRevision(
  level: ProblemLevel,
  files: Readonly<Record<string, string>>,
): string {
  return JSON.stringify([
    level.slug,
    level.contentVersion,
    level.files
      .filter((file) => file.access !== "hidden")
      .map((file) => [file.path, files[file.path] ?? file.initialValue])
      .sort(([left], [right]) => left!.localeCompare(right!)),
  ]);
}

export function initialWorkspace(level: ProblemLevel): Record<string, string> {
  return Object.fromEntries(
    level.files
      .filter((file) => file.access !== "hidden")
      .map((file) => [file.path, file.initialValue]),
  );
}
