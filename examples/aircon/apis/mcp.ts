import { Mcp, Session } from "@acid-cat/core-effect";
import { Context, Effect, Layer, Schema, SubscriptionRef } from "effect";
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
  readonly allowedOrigins?: readonly string[] | undefined;
}

export function mcpApi(options: McpApiOptions = {}) {
  const allowedOrigins = [...(options.allowedOrigins ?? [])];
  const built = Effect.runSync(Effect.scoped(Layer.build(unitLayer)));
  const unit = Layer.succeedContext(built);

  const server = McpServer.toolkit(AirconTools).pipe(
    Layer.provide(handlers),
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "aircon",
        version: "0.1.0",
        path: "/mcp",
        protocols: [McpProtocol.v2026_07_28],
        allowedOrigins,
        extensions: Mcp.eventsExtensions,
      }),
    ),
    Layer.provide(unit),
  );
  const application = HttpRouter.toWebHandler(server, { disableLogger: true });
  const withEvents = Mcp.withEvents(aircon, unit, application.handler, { allowedOrigins });
  const binding = Mcp.toWebHandler(aircon, unit, { name: "aircon", version: "0.1.0", allowedOrigins, path: "/capabilities/mcp" });
  // For clients that still open the session with the `initialize` handshake of revision 2025-11-25 or 2025-06-18.
  const legacy = Mcp.withHandshake(
    Mcp.toWebHandler(aircon, unit, { name: "aircon", version: "0.1.0", allowedOrigins, path: "/capabilities/mcp-legacy" }),
  );

  return {
    handler: (request: Request): Promise<Response> => {
      const path = new URL(request.url).pathname;
      if (path === "/capabilities/mcp-legacy") return legacy(request);
      return path.startsWith("/capabilities/") ? binding(request) : withEvents(request);
    },
    statusListeners: () => SubscriptionRef.getUnsafe(Context.get(built, Unit).statusListeners),
    dispose: async () => {
      await withEvents.dispose();
      await application.dispose();
    },
  };
}
