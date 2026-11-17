// The plain facts that every core shares: names, numbers and the templates of messages. No rule reads them, so they
// need no proofs. A command or a flag that a rule reads is a list of characters.
module facts {
  type RpcCode = NoCode | Code(int)

  pure val CALL_FAILURE_KINDS: List[str] = ["cancelled", "unknown-capability", "unavailable", "invalid-input", "internal"]

  pure val CLI_EXIT_CODES: List[(str, int)] = [
    ("value", 0),
    ("failure", 1),
    ("unknown-capability", 2),
    ("invalid-input", 3),
    ("unavailable", 4),
    ("internal", 5),
    ("cancelled", 130),
  ]

  pure def exitCode(name: str): int = CLI_EXIT_CODES.foldl(-1, (found, entry) => if (entry._1 == name) entry._2 else found)

  pure val INVALID_INPUT_EXIT_CODE: int = exitCode("invalid-input")

  pure val CLI_WATCH_EXIT_CODES: List[(str, int)] = [
    ("complete", exitCode("value")),
    ("cancelled", exitCode("cancelled")),
    ("internal", exitCode("internal")),
  ]

  pure val HTTP_STATUS: List[(str, int)] = [
    ("unknown-capability", 404),
    ("invalid-input", 422),
    ("unavailable", 503),
    ("cancelled", 409),
    ("internal", 500),
  ]

  pure val CLI_GENERIC_COMMANDS: List[List[str]] = [["c", "a", "l", "l"], ["l", "i", "s", "t"], ["w", "a", "t", "c", "h"]]

  pure val PROGRAM_FLAGS: List[List[str]] = [["-", "-", "h", "e", "l", "p"], ["-", "-", "v", "e", "r", "s", "i", "o", "n"]]

  pure val RESUME_FLAGS: List[List[str]] = [["-", "-", "c", "u", "r", "s", "o", "r"], ["-", "-", "m", "a", "x", "-", "a", "g", "e", "-", "m", "s"]]

  pure val KEEPALIVE_MS: int = 15000

  pure val SSE_MEDIA_TYPE: str = "text/event-stream"

  pure val MCP_PROTOCOL_VERSION: str = "2026-07-28"

  pure val MCP_EVENTS_EXTENSION: str = "io.modelcontextprotocol/events"

  pure val MCP_SUBSCRIPTION_ID: str = "io.modelcontextprotocol/subscriptionId"

  pure val MCP_UNKNOWN_TOOL: int = -32602

  pure val MCP_EVENT_ERRORS: List[(str, int)] = [
    ("notFound", -32023),
    ("forbidden", -32024),
    ("resourceExhausted", -32025),
    ("unsupported", -32026),
    ("callbackEndpoint", -32027),
    ("invalidParams", -32602),
    ("internal", -32603),
  ]

  pure val MCP_REJECTIONS: List[{ rejection: str, status: int, code: RpcCode }] = [
    { rejection: "method", status: 405, code: NoCode },
    { rejection: "origin", status: 403, code: NoCode },
    { rejection: "media-type", status: 415, code: NoCode },
    { rejection: "too-large", status: 413, code: Code(-32600) },
    { rejection: "not-utf8", status: 400, code: Code(-32700) },
  ]

  pure val START_MESSAGES: { genericCommand: str, sharedPrefix: str, resumeProperty: str } = {
    genericCommand: "The command {command} has the same name as a command of the command line.",
    sharedPrefix: "The command {command} is also the start of the command {longer}. A shared prefix only contains other commands.",
    resumeProperty: "The input of the event {id} has a property {flag}, which is a flag of watch.",
  }

  pure val ALIAS_MESSAGES: List[(str, str)] = [
    ("settingsNotObject", "{where}: options.cli must be an object"),
    ("noCliBinding", "{where}: has options.cli, but not the binding cli"),
    ("aliasesNotObject", "{where}: options.cli.aliases must be an object"),
    ("badName", "{where}: the alias {name} must be one word, or -- and one word, with the letters a-z, the digits 0-9 and single hyphens"),
    ("reservedName", "{where}: the alias {name} has the name of a command or a flag of the command line"),
    ("firstWord", "{where}: the alias {name} has the name of the first word of the command of a capability"),
    ("badTarget", "{where}: the alias {name} must be an object with the id of a capability in capability, or the id of an event in event"),
    ("unknownMember", "{where}: the alias {name} has the unknown member {members}"),
    ("notInView", "{where}: the alias {name} refers to {id}, which is not {kind} in the view of the target"),
    ("inputNotObject", "{where}: the alias {name} must have an object as its input"),
    ("noProperties", "{where}: the alias {name} has a fixed input, but the input schema of {id} has no properties"),
    ("notAProperty", "{where}: the alias {name} has the fixed input {members}, which is not a property of the input of {id}"),
    ("badDefault", "{where}: options.cli.default must be the name of a command alias"),
    ("defaultHasReservedFlag", "{where}: the default alias {name} has the flag {flag}, which is a flag of the command line"),
    ("flagOfDefault", "{where}: the alias {name} has the name of a flag of the default alias {default}"),
  ]
}

module factsData {
  import facts.* from "./facts"

  var facts: {
    callFailureKinds: List[str],
    cliExitCodes: List[(str, int)],
    cliWatchExitCodes: List[(str, int)],
    httpStatus: List[(str, int)],
    cliGenericCommands: List[List[str]],
    programFlags: List[List[str]],
    resumeFlags: List[List[str]],
    keepaliveMs: int,
    sseMediaType: str,
    mcpProtocolVersion: str,
    mcpEventsExtension: str,
    mcpSubscriptionId: str,
    mcpUnknownTool: int,
    mcpEventErrors: List[(str, int)],
    mcpRejections: List[{ rejection: str, status: int, code: RpcCode }],
    startMessages: { genericCommand: str, sharedPrefix: str, resumeProperty: str },
    aliasMessages: List[(str, str)],
  }

  action init = facts' = {
    callFailureKinds: CALL_FAILURE_KINDS,
    cliExitCodes: CLI_EXIT_CODES,
    cliWatchExitCodes: CLI_WATCH_EXIT_CODES,
    httpStatus: HTTP_STATUS,
    cliGenericCommands: CLI_GENERIC_COMMANDS,
    programFlags: PROGRAM_FLAGS,
    resumeFlags: RESUME_FLAGS,
    keepaliveMs: KEEPALIVE_MS,
    sseMediaType: SSE_MEDIA_TYPE,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    mcpEventsExtension: MCP_EVENTS_EXTENSION,
    mcpSubscriptionId: MCP_SUBSCRIPTION_ID,
    mcpUnknownTool: MCP_UNKNOWN_TOOL,
    mcpEventErrors: MCP_EVENT_ERRORS,
    mcpRejections: MCP_REJECTIONS,
    startMessages: START_MESSAGES,
    aliasMessages: ALIAS_MESSAGES,
  }

  action step = facts' = facts
}
