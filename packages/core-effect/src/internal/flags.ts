import type { Param } from "effect/cli";

/** The names and the aliases of a flag. */
export function flagNames(flag: Param.Param<"flag", unknown>): string[] {
  return flagParams(flag).flatMap((single) => [single.name, ...single.aliases]);
}

/** The single flags that a flag is made of: one, or more when it has alternatives. */
export function flagParams(flag: Param.Param<"flag", unknown>): Param.Single<"flag", unknown>[] {
  const node = flag as Param.Single<"flag", unknown> | Param.Map<"flag", unknown, unknown> | Param.Transform<"flag", unknown, unknown> | Param.Optional<"flag", unknown> | Param.Variadic<"flag", unknown>;
  switch (node._tag) {
    case "Single":
      return [node];
    case "Transform":
      return [...flagParams(node.param), ...node.alternatives.flatMap((alternative) => flagParams(alternative() as Param.Param<"flag", unknown>))];
    case "Map":
    case "Optional":
    case "Variadic":
      return flagParams(node.param);
  }
}
