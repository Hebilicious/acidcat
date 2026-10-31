/**
 * An MCP server for the air conditioner, written fully in Effect with `effect/ai`, next to the MCP binding.
 *
 * The tools are a design choice: `get_status`, and `set_controls`, which changes many settings in one call. Each tool
 * calls the capabilities with typed calls, through a session of the `mcp` target. The MCP binding of
 * `@acid-cat/core-effect` serves one tool for each capability. It is served two times:
 *
 * - at `/capabilities/mcp`, with revision 2026-07-28 only. Use this form when your clients support this revision.
 * - at `/capabilities/mcp-handshake`, wrapped in `Mcp.withHandshake`, for clients that still open the session with the
 *   `initialize` handshake of revision 2025-11-25 or 2025-06-18.
 */
import { Mcp, Session } from "@acid-cat/core-effect";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter } from "effect/http";

import {
  aircon,
  Celsius,
  fanSet,
  FanSpeed,
  Mode,
  modeSet,
  Offline,
  PoweredOff,
  powerSet,
  Status,
  statusGet,
  temperatureSet,
  Unit,
  unitLayer,
} from "../core-effect/aircon.ts";

const GetStatus = Tool.make("get_status", {
  description: "Read the power, mode, fan speed, target temperature and room temperature of the air conditioner.",
  success: Status,
  failure: Offline,
}).annotate(Tool.Readonly, true);

const SetControls = Tool.make("set_controls", {
  description:
    "Change the power, mode, fan speed and target temperature of the air conditioner in one call. A setting that is not given does not change. Gives the new status.",
  parameters: Schema.Struct({
    power: Schema.optional(Schema.Boolean),
    mode: Schema.optional(Mode),
    fan: Schema.optional(FanSpeed),
    targetCelsius: Schema.optional(Celsius),
  }),
  success: Status,
  failure: Schema.Union([Offline, PoweredOff]),
});

export const AirconTools = Toolkit.make(GetStatus, SetControls);

/**
 * The tools call the capabilities through a session of the `mcp` target. Each tool call is one request of one client,
 * so it opens its own session, and closes it when the call ends. All sessions share the unit.
 */
const handlers = AirconTools.toLayer(
  Effect.gen(function* () {
    const services = yield* Effect.context<Unit>();
    const withSession = <A, E>(use: (session: Session.Session<Unit>) => Effect.Effect<A, E | Session.CallFailed>) =>
      Session.make(aircon, { target: "mcp" }).pipe(
        Effect.flatMap(use),
        // A call failure is not a failure of the tool. The server reports it as an internal error.
        Effect.catchTag("CallFailed", Effect.die),
        Effect.scoped,
        Effect.provideContext(services),
      );
    const status = (session: Session.Session<Unit>) => session.execute(statusGet, {});
    return {
      get_status: () => withSession(status),
      set_controls: (controls) =>
        withSession((session) =>
          Effect.gen(function* () {
            if (controls.power !== undefined) yield* session.execute(powerSet, { on: controls.power });
            if (controls.mode !== undefined) yield* session.execute(modeSet, { mode: controls.mode });
            if (controls.fan !== undefined) yield* session.execute(fanSet, { speed: controls.fan });
            if (controls.targetCelsius !== undefined) yield* session.execute(temperatureSet, { celsius: controls.targetCelsius });
            return yield* status(session);
          }),
        ),
    };
  }),
);

export interface McpApiOptions {
  /** The origins that can call the servers. A request with no `Origin` header is accepted. */
  readonly allowedOrigins?: readonly string[] | undefined;
}

/**
 * A web request handler: the MCP server of the application at `/mcp`, and the MCP binding at `/capabilities/mcp` and
 * `/capabilities/mcp-handshake`. All use the same unit. `dispose` stops the server of the application.
 */
export function mcpApi(options: McpApiOptions = {}) {
  const allowedOrigins = [...(options.allowedOrigins ?? [])];
  // Build the unit once, so that both servers use it.
  const unit = Layer.succeedContext(Effect.runSync(Effect.scoped(Layer.build(unitLayer))));

  const server = McpServer.toolkit(AirconTools).pipe(
    Layer.provide(handlers),
    Layer.provideMerge(
      McpServer.layerHttp({ name: "aircon", version: "0.1.0", path: "/mcp", protocols: [McpProtocol.v2026_07_28], allowedOrigins }),
    ),
    Layer.provide(unit),
  );
  const application = HttpRouter.toWebHandler(server, { disableLogger: true });
  const binding = Mcp.toWebHandler(aircon, unit, { name: "aircon", version: "0.1.0", allowedOrigins, path: "/capabilities/mcp" });
  const handshake = Mcp.withHandshake(
    Mcp.toWebHandler(aircon, unit, { name: "aircon", version: "0.1.0", allowedOrigins, path: "/capabilities/mcp-handshake" }),
  );

  return {
    handler: (request: Request): Promise<Response> => {
      const path = new URL(request.url).pathname;
      if (path === "/capabilities/mcp-handshake") return handshake(request);
      return path.startsWith("/capabilities/") ? binding(request) : application.handler(request);
    },
    dispose: application.dispose,
  };
}
