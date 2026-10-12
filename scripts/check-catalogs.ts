/**
 * Check every example catalog against the specification.
 *
 * For each `examples/<name>.pkl`, the committed `examples/<name>.acidcat.json` must be exactly what Pkl renders
 * now. The rendered catalog must then validate against `schemas/catalog.schema.json`, follow the rules the schema
 * cannot express (see spec/conformance.md), and contain only schemas that compile.
 *
 * Usage: node scripts/check-catalogs.ts
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

interface Capability {
  readonly audience?: readonly string[];
  readonly input?: Record<string, unknown>;
  readonly output?: unknown;
  readonly state?: unknown;
  readonly failures?: Record<string, unknown>;
}

interface Catalog {
  readonly targets: Record<string, unknown>;
  readonly capabilities: Record<string, Capability>;
}

const root = path.resolve(import.meta.dirname, "..");
const examples = path.join(root, "examples");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateCatalog = ajv.compile(readJson(path.join(root, "schemas/catalog.schema.json")));

const problems: string[] = [];

for (const source of readdirSync(examples).filter((name) => name.endsWith(".pkl"))) {
  const name = source.slice(0, -".pkl".length);
  const renderedPath = path.join(examples, `${name}.acidcat.json`);
  const rendered = execFileSync("pkl", ["eval", path.join(examples, source)], { encoding: "utf-8" });

  if (rendered !== readFileSync(renderedPath, "utf-8")) {
    problems.push(`${name}: ${name}.acidcat.json is stale; run \`moon run examples\``);
  }

  const catalog = JSON.parse(rendered) as Catalog;
  if (!validateCatalog(catalog)) {
    problems.push(`${name}: ${ajv.errorsText(validateCatalog.errors)}`);
    continue;
  }
  problems.push(...ruleProblems(name, catalog));
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Every example catalog conforms.\n");

/** The catalog rules that JSON Schema cannot express. */
function ruleProblems(name: string, catalog: Catalog): string[] {
  const found: string[] = [];
  for (const [id, capability] of Object.entries(catalog.capabilities)) {
    for (const target of capability.audience ?? []) {
      if (!(target in catalog.targets)) {
        found.push(`${name}: ${id} names the undeclared target ${target}`);
      }
    }
    const schemas = [capability.input, capability.output, capability.state, ...Object.values(capability.failures ?? {})];
    for (const schema of schemas) {
      if (schema === undefined) {
        continue;
      }
      try {
        ajv.compile(schema as object);
      } catch (cause) {
        found.push(`${name}: ${id} has a schema that does not compile: ${String(cause)}`);
      }
    }
  }
  return found;
}

function readJson(file: string): object {
  return JSON.parse(readFileSync(file, "utf-8")) as object;
}
