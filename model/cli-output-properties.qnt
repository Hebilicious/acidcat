module cliOutputNames {
  import cliOutput.* from "./cli-output"

  pure val NAMES: Set[Text] = Set(
    ["-", "-", "j", "s", "o", "n"],
    ["-", "j"],
    ["-", "-", "h", "e", "l", "p"],
    ["-", "-", "n", "o", "w"],
    ["j", "s", "o", "n"],
    ["-", "a", "b"],
    ["-", "-", "a", "-"],
    ["-", "-", "a", "=", "b"],
    ["-", "-"],
  )

  pure val KINDS: Set[Kind] = Set(Switch(Human), Switch(Json), Values([]), Values([(["t"], Human), (["j"], Json)]))

  pure val OTHERS: List[(Text, str)] = RESERVED_FLAGS.concat([
    (["-", "-", "n", "o", "w"], "the flag alias --now"),
    (["-", "-", "b", "r", "o", "k", "e", "n"], "a flag of the capability probe.read"),
  ])

  var flags: List[OutputFlag]

  action init = {
    nondet flagCount = 0.to(2).oneOf()
    nondet names0 = 0.to(2).oneOf()
    nondet names1 = 0.to(2).oneOf()
    nondet n00 = NAMES.oneOf()
    nondet n01 = NAMES.oneOf()
    nondet n10 = NAMES.oneOf()
    nondet n11 = NAMES.oneOf()
    nondet k0 = KINDS.oneOf()
    nondet k1 = KINDS.oneOf()
    flags' = [{ names: [n00, n01].slice(0, names0), kind: k0 }, { names: [n10, n11].slice(0, names1), kind: k1 }].slice(0, flagCount)
  }

  action step = flags' = flags

  pure def allNames(config: List[OutputFlag]): List[Text] = config.foldl([], (names, flag) => names.concat(flag.names))

  val acceptedNamesAreSafe = {
    val names = allNames(flags)
    outputProblems(flags, OTHERS) == [] implies and {
      names.indices().forall(i => names.indices().forall(j => i == j or names[i] != names[j])),
      names.indices().forall(i => and {
        isName(names[i]),
        names[i][0] == "-",
        names[i] != END_OF_FLAGS,
        not(includes(names[i], "=")),
        takenBy(OTHERS, names[i]) == Free,
      }),
    }
  }
}

// The command line reads arguments only with a configuration that has no problems.
module cliOutputArguments {
  import cliOutput.* from "./cli-output"

  pure val MOST_SEGMENTS = 2
  pure val MOST_AFTER = 1
  pure val MOST_NAMES = 2

  pure val UNKNOWN_VALUE: Text = ["b"]
  pure val DEPLOY: Text = ["d"]

  pure val LONG_NAMES: Set[Text] = Set(["-", "-", "a"], ["-", "-", "b"])
  pure val NAMES: Set[Text] = LONG_NAMES.union(Set(["-", "a"], ["-", "b"]))
  pure val VALUES: Set[Text] = Set(["t"], ["j"])

  pure val KINDS: Set[Kind] = Set(Switch(Human), Switch(Json), Values([(["t"], Human), (["j"], Json)]), Values([(["j"], Json)]))

  // Words that are not output flags, not `--` and not an application command.
  pure val PLAIN_WORDS: Set[Text] = Set(["x"], ["-", "-", "z"], ["-", "z"], ["-", "-", "z", "=", "1"])

  pure val AFTER_WORDS: Set[Text] = Set(["x"], ["-", "-", "a"], ["-", "a"], ["-", "-"], DEPLOY, UNKNOWN_VALUE)

  pure val ENV_VALUES: Set[Text] = Set([], ["0"], ["1"], [" ", "O", "f", "F"])

  type Use = PlainWord | SwitchUse | ValueUse

  type Segment = { args: List[Text], use: Use, name: Text, value: Text }

  pure def withEquals(name: Text, value: Text): Text = name.append("=").concat(value)

  pure val SEGMENTS: Set[Segment] = PLAIN_WORDS.map(word => { args: [word], use: PlainWord, name: [], value: [] })
    .union(NAMES.map(name => { args: [name], use: SwitchUse, name: name, value: [] }))
    .union(tuples(NAMES, VALUES).map(((name, value)) => { args: [name, value], use: ValueUse, name: name, value: value }))
    .union(tuples(LONG_NAMES, VALUES).map(((name, value)) => { args: [withEquals(name, value)], use: ValueUse, name: name, value: value }))

  pure val BAD_ENDINGS: Set[Segment] = NAMES.map(name => { args: [name], use: ValueUse, name: name, value: [] })
    .union(NAMES.map(name => { args: [name, UNKNOWN_VALUE], use: ValueUse, name: name, value: UNKNOWN_VALUE }))
    .union(LONG_NAMES.map(name => { args: [withEquals(name, UNKNOWN_VALUE)], use: ValueUse, name: name, value: UNKNOWN_VALUE }))

  var flags: List[OutputFlag]
  var segments: List[Segment]
  var bad: Segment
  var after: List[Text]
  var commands: List[Text]
  var stopper: Text
  var env: str -> Text
  var isTerminal: bool
  var fallback: Default

  action init = {
    nondet flagCount = 0.to(2).oneOf()
    nondet names0 = 0.to(MOST_NAMES).oneOf()
    nondet names1 = 0.to(MOST_NAMES).oneOf()
    nondet n00 = NAMES.oneOf()
    nondet n01 = NAMES.oneOf()
    nondet n10 = NAMES.oneOf()
    nondet n11 = NAMES.oneOf()
    nondet k0 = KINDS.oneOf()
    nondet k1 = KINDS.oneOf()
    nondet segmentCount = 0.to(MOST_SEGMENTS).oneOf()
    nondet s0 = SEGMENTS.oneOf()
    nondet s1 = SEGMENTS.oneOf()
    nondet s2 = SEGMENTS.oneOf()
    nondet ending = BAD_ENDINGS.oneOf()
    nondet afterCount = 0.to(MOST_AFTER).oneOf()
    nondet a0 = AFTER_WORDS.oneOf()
    nondet a1 = AFTER_WORDS.oneOf()
    nondet commandCount = 0.to(1).oneOf()
    nondet stop = Set(END_OF_FLAGS, DEPLOY).oneOf()
    nondet ciValue = ENV_VALUES.oneOf()
    nondet agent = AGENT_VARIABLES.indices().oneOf()
    nondet agentValue = ENV_VALUES.oneOf()
    nondet envShape = 0.to(3).oneOf()
    nondet terminal = Bool.oneOf()
    nondet defaultForm = Set(AutoDefault, JsonDefault).oneOf()
    all {
      flags' = [{ names: [n00, n01].slice(0, names0), kind: k0 }, { names: [n10, n11].slice(0, names1), kind: k1 }].slice(0, flagCount),
      segments' = [s0, s1, s2].slice(0, segmentCount),
      bad' = ending,
      after' = [a0, a1].slice(0, afterCount),
      commands' = [DEPLOY].slice(0, commandCount),
      stopper' = stop,
      env' =
        if (envShape == 0) Map()
        else if (envShape == 1) Map(CI_VARIABLE -> ciValue)
        else if (envShape == 2) Map(AGENT_VARIABLES[agent] -> agentValue)
        else Map(CI_VARIABLE -> ciValue, AGENT_VARIABLES[agent] -> agentValue),
      isTerminal' = terminal,
      fallback' = defaultForm,
    }
  }

  action step = all {
    flags' = flags,
    segments' = segments,
    bad' = bad,
    after' = after,
    commands' = commands,
    stopper' = stopper,
    env' = env,
    isTerminal' = isTerminal,
    fallback' = fallback,
  }

  pure def accepted(config: List[OutputFlag]): bool = outputProblems(config, []) == []

  pure def chosenBy(config: List[OutputFlag], segment: Segment): Chosen =
    match segment.use {
      | PlainWord => ByDefault
      | SwitchUse => match flagNamed(config, segment.name) {
        | FlagFound(kind) => match kind { | Switch(form) => ByFlag(form) | Values(_) => ByDefault }
        | NoFlag => ByDefault
      }
      | ValueUse => match flagNamed(config, segment.name) {
        | FlagFound(kind) => match kind {
          | Values(values) => match formOfValue(values, segment.value) { | ValueFound(form) => ByFlag(form) | NoValue => ByDefault }
          | Switch(_) => ByDefault
        }
        | NoFlag => ByDefault
      }
    }

  pure def fits(config: List[OutputFlag], segment: Segment): bool = segment.use == PlainWord or chosenBy(config, segment) != ByDefault

  pure def joinedArgs(list: List[Segment]): List[Text] = list.foldl([], (args, segment) => args.concat(segment.args))

  pure def plainArgs(list: List[Segment]): List[Text] =
    list.foldl([], (args, segment) => if (segment.use == PlainWord) args.concat(segment.args) else args)

  pure def lastChosen(config: List[OutputFlag], list: List[Segment]): Chosen =
    list.foldl(ByDefault, (chosen, segment) => if (segment.use == PlainWord) chosen else chosenBy(config, segment))

  val readable = accepted(flags) and segments.foldl(true, (all_fit, segment) => all_fit and fits(flags, segment))

  val notTerminalGivesJson = {
    val plain = plainArgs(segments)
    val args = if (stopper == END_OF_FLAGS) plain.append(END_OF_FLAGS).concat(after) else plain
    val offTerminal = accepted(flags) and not(isTerminal)
    offTerminal implies decide(fallback, isTerminal, env, outputChoice(flags, args, commands)) == Proceeds({ form: Json, rest: args })
  }

  val argumentsAfterTheStopStay = {
    val plain = plainArgs(segments)
    val stopsHere = stopper == END_OF_FLAGS or (includes(commands, stopper) and plain == [])
    val args = joinedArgs(segments).append(stopper).concat(after)
    val stops = readable and stopsHere
    stops implies outputChoice(flags, args, commands) == Parsed({ chosen: lastChosen(flags, segments), rest: plain.append(stopper).concat(after) })
  }

  val lastOutputFlagWins = {
    val chosen = lastChosen(flags, segments)
    val withFlag = readable and chosen != ByDefault
    withFlag implies outputChoice(flags, joinedArgs(segments), commands) == Parsed({ chosen: chosen, rest: plainArgs(segments) })
  }

  val badValueStops = match flagNamed(flags, bad.name) {
    | NoFlag => true
    | FlagFound(kind) => match kind {
      | Switch(_) => true
      | Values(values) => {
        val args = joinedArgs(segments).concat(bad.args).concat(if (bad.value == []) [] else after)
        val failure = { flag: bad.name, values: valueNames(values) }
        readable implies and {
          outputChoice(flags, args, commands) == BadValue(failure),
          decide(fallback, isTerminal, env, BadValue(failure)) == Stops({ exitCode: INVALID_INPUT_EXIT_CODE, flag: failure.flag, values: failure.values }),
        }
      }
    }
  }
}
