module cliAliasCases {
  import cliAliases.* from "./cli-aliases"

  pure val PROBE_READ: Text = ["p", "r", "o", "b", "e", ".", "r", "e", "a", "d"]
  pure val PROBE_RAW: Text = ["p", "r", "o", "b", "e", ".", "r", "a", "w"]
  pure val PROBE_NONE: Text = ["p", "r", "o", "b", "e", ".", "n", "o", "n", "e"]
  pure val HIDDEN_OP: Text = ["h", "i", "d", "d", "e", "n", ".", "o", "p"]
  pure val PROBE_CHANGED: Text = ["p", "r", "o", "b", "e", ".", "c", "h", "a", "n", "g", "e", "d"]
  pure val PROBE_GONE: Text = ["p", "r", "o", "b", "e", ".", "g", "o", "n", "e"]
  pure val PROBE_TICKED: Text = ["p", "r", "o", "b", "e", ".", "t", "i", "c", "k", "e", "d"]

  pure val PATH_PROPERTY: Text = ["p", "a", "t", "h"]
  pure val HELP_PROPERTY: Text = ["h", "e", "l", "p"]
  pure val NOPE: Text = ["n", "o", "p", "e"]
  pure val OTHER: Text = ["o", "t", "h", "e", "r"]
  pure val X_NOTE: Text = ["x", "-", "n", "o", "t", "e"]

  pure val CAPABILITIES: List[Entry] = [
    { id: PROBE_READ, inView: true, input: Properties([PATH_PROPERTY, HELP_PROPERTY]) },
    { id: PROBE_RAW, inView: true, input: NoProperties },
    { id: PROBE_NONE, inView: true, input: NoSchema },
    { id: HIDDEN_OP, inView: false, input: NoSchema },
  ]

  pure val EVENTS: List[Entry] = [
    { id: PROBE_CHANGED, inView: true, input: Properties([PATH_PROPERTY]) },
    { id: PROBE_GONE, inView: false, input: NoSchema },
    { id: PROBE_TICKED, inView: true, input: NoSchema },
  ]

  pure def capabilityValue(id: Text, input: FixedInput): AliasValue = AliasObject({ capability: Id(id), event: Absent, input: input, others: [] })
  pure def eventValue(id: Text, input: FixedInput): AliasValue = AliasObject({ capability: Absent, event: Id(id), input: input, others: [] })

  pure val VALUES: List[AliasValue] = [
    capabilityValue(PROBE_READ, NoFixedInput),
    capabilityValue(PROBE_READ, FixedKeys([PATH_PROPERTY])),
    capabilityValue(PROBE_READ, FixedKeys([HELP_PROPERTY])),
    capabilityValue(PROBE_READ, FixedKeys([NOPE])),
    capabilityValue(PROBE_READ, FixedKeys([OTHER, PATH_PROPERTY, NOPE])),
    capabilityValue(PROBE_READ, FixedNotObject),
    capabilityValue(PROBE_RAW, NoFixedInput),
    capabilityValue(PROBE_RAW, FixedKeys([PATH_PROPERTY])),
    capabilityValue(PROBE_NONE, FixedKeys([])),
    capabilityValue(HIDDEN_OP, NoFixedInput),
    capabilityValue(PROBE_CHANGED, NoFixedInput),
    eventValue(PROBE_CHANGED, NoFixedInput),
    eventValue(PROBE_CHANGED, FixedKeys([PATH_PROPERTY])),
    eventValue(PROBE_GONE, NoFixedInput),
    eventValue(PROBE_TICKED, FixedKeys([])),
    eventValue(PROBE_READ, NoFixedInput),
    NotObject,
    AliasObject({ capability: Id(PROBE_READ), event: Id(PROBE_CHANGED), input: NoFixedInput, others: [] }),
    AliasObject({ capability: Null, event: Id(PROBE_CHANGED), input: NoFixedInput, others: [] }),
    AliasObject({ capability: Null, event: Absent, input: NoFixedInput, others: [] }),
    AliasObject({ capability: NotText, event: Absent, input: NoFixedInput, others: [] }),
    AliasObject({ capability: Absent, event: Absent, input: NoFixedInput, others: [] }),
    AliasObject({ capability: Id(PROBE_READ), event: Absent, input: NoFixedInput, others: [X_NOTE] }),
    AliasObject({ capability: Id(PROBE_READ), event: Absent, input: FixedKeys([NOPE]), others: [OTHER, X_NOTE, NOPE] }),
  ]

  pure val NAMES: List[Text] = [
    ["s"],
    ["l", "i", "s", "t"],
    ["p", "r", "o", "b", "e"],
    ["h", "i", "d", "d", "e", "n"],
    ["a", "-", "1"],
    ["a", "-", "-", "b"],
    ["B"],
    ["-", "x"],
    ["-", "-", "h", "e", "l", "p"],
    ["-", "-", "p", "a", "t", "h"],
    ["-", "-", "c", "u", "r", "s", "o", "r"],
  ]

  pure val UNDECLARED: Text = ["z", "z"]

  pure def defaultsFor(name: Text): List[DefaultSetting] = [NoDefault, DefaultNotText, DefaultName(name), DefaultName(UNDECLARED)]

  pure def declared(aliases: List[(Text, AliasValue)], fallback: DefaultSetting): Declared =
    { cliBinding: true, settings: SettingsObject({ aliases: AliasMembers(aliases), default: fallback }) }

  pure val ONE_ALIAS: List[Declared] = NAMES.foldl([], (cases, name) => VALUES.foldl(cases, (byValue, value) =>
    defaultsFor(name).foldl(byValue, (more, fallback) => more.append(declared([(name, value)], fallback)))))

  pure val PAIR_NAMES: List[Text] = [["s"], ["t"], ["-", "-", "p", "a", "t", "h"], ["-", "-", "c", "u", "r", "s", "o", "r"], ["-", "-", "z", "a", "p"]]

  pure val PAIR_VALUES: List[AliasValue] = [
    capabilityValue(PROBE_READ, NoFixedInput),
    capabilityValue(PROBE_READ, FixedKeys([PATH_PROPERTY])),
    capabilityValue(PROBE_READ, FixedKeys([NOPE])),
    eventValue(PROBE_CHANGED, NoFixedInput),
    eventValue(PROBE_CHANGED, FixedKeys([PATH_PROPERTY])),
    NotObject,
  ]

  pure val TWO_ALIASES: List[Declared] = PAIR_NAMES.foldl([], (cases, second) => PAIR_NAMES.foldl(cases, (byFirst, first) =>
    if (first == second) byFirst
    else PAIR_VALUES.foldl(byFirst, (byValue, firstValue) => PAIR_VALUES.foldl(byValue, (more, secondValue) =>
      more.append(declared([(second, secondValue), (first, firstValue)], DefaultName(second)))))))

  pure val STATUS: Text = ["s", "t", "a", "t", "u", "s"]

  pure val TARGET_CASES: List[Declared] = [true, false].foldl([], (cases, binding) => cases.concat([
    { cliBinding: binding, settings: NoSettings },
    { cliBinding: binding, settings: SettingsNotObject },
    { cliBinding: binding, settings: SettingsObject({ aliases: AliasesAbsent, default: NoDefault }) },
    { cliBinding: binding, settings: SettingsObject({ aliases: AliasesAbsent, default: DefaultName(STATUS) }) },
    { cliBinding: binding, settings: SettingsObject({ aliases: AliasesNotObject, default: DefaultName(STATUS) }) },
    { cliBinding: binding, settings: SettingsObject({ aliases: AliasMembers([(STATUS, capabilityValue(PROBE_RAW, NoFixedInput))]), default: DefaultName(STATUS) }) },
  ]))

  var catalog: { capabilities: List[Entry], events: List[Entry] }

  var aliasCases: List[{ declared: Declared, result: Result }]

  action init = all {
    catalog' = { capabilities: CAPABILITIES, events: EVENTS },
    aliasCases' = TARGET_CASES.concat(ONE_ALIAS).concat(TWO_ALIASES).foldl([], (cases, each) =>
      cases.append({ declared: each, result: aliasesOf(CAPABILITIES, EVENTS, each) })),
  }

  action step = all {
    catalog' = catalog,
    aliasCases' = aliasCases,
  }
}
