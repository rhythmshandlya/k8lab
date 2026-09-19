/** Refresh pinned upstream OpenAPI schemas. Runtime validation never uses the network. */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const directory = new URL("../src/lib/kube/schemas/", import.meta.url);
await mkdir(directory, { recursive: true });
const sources = [];
for (const version of ["1.34.0", "1.35.0", "1.36.0"]) {
  const url = `https://raw.githubusercontent.com/kubernetes/kubernetes/v${version}/api/openapi-spec/swagger.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const source = await response.text();
  const openapi = JSON.parse(source);
  const definitions = {};
  const resources = {};
  function retain(name) {
    if (definitions[name]) return;
    const schema = openapi.definitions[name];
    if (!schema) throw new Error(`Missing schema ${name}`);
    definitions[name] = {};
    definitions[name] = clean(schema);
  }
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        ((key === "description" || key === "title" || key === "default") &&
          typeof child !== "object") ||
        key.startsWith("x-")
      )
        continue;
      if (key === "$ref" && typeof child === "string") retain(child.replace("#/definitions/", ""));
      result[key] = clean(child);
    }
    // OpenAPI marks IntOrString as a string plus an extension. Preserve both types.
    if (value["x-kubernetes-int-or-string"] === true || value.format === "int-or-string") {
      delete result.type;
      delete result.format;
      result.anyOf = [{ type: "integer" }, { type: "string" }];
    }
    return result;
  }
  for (const [name, schema] of Object.entries(openapi.definitions)) {
    for (const gvk of schema["x-kubernetes-group-version-kind"] ?? []) {
      if (gvk.kind.endsWith("List") || !schema.properties?.metadata) continue;
      const apiVersion = gvk.group ? `${gvk.group}/${gvk.version}` : gvk.version;
      resources[`${apiVersion}/${gvk.kind}`] = name;
      retain(name);
    }
  }
  const ordered = Object.fromEntries(
    Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)),
  );
  const filename = `kubernetes-${version.slice(0, 4)}.json`;
  await writeFile(
    new URL(filename, directory),
    JSON.stringify({ version, resources, definitions: ordered }),
  );
  sources.push({
    filename,
    url,
    sha256: createHash("sha256").update(source).digest("hex"),
    license: "Apache-2.0",
  });
  console.log(
    `${version}: ${Object.keys(resources).length} APIs, ${Object.keys(definitions).length} definitions`,
  );
}
await writeFile(new URL("sources.json", directory), JSON.stringify(sources, null, 2) + "\n");
