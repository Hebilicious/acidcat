import type { Param } from "effect/cli";

/** The names and the aliases of a flag. */
export function flagNames(flag: Param.Param<"flag", unknown>): string[] {
  const node = flag as Param.Single<"flag", unknown> | Param.Map<"flag", unknown, unknown> | Param.Transform<"flag", unknown, unknown> | Param.Optional<"flag", unknown> | Param.Variadic<"flag", unknown>;
  switch (node._tag) {
    case "Single":
      return [node.name, ...node.aliases];
    case "Transform":
      return [...flagNames(node.param), ...node.alternatives.flatMap((alternative) => flagNames(alternative() as Param.Param<"flag", unknown>))];
    case "Map":
    case "Optional":
    case "Variadic":
      return flagNames(node.param);
  }
}
