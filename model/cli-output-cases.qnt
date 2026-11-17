module cliOutputCases {
  import cliOutput.* from "./cli-output"

  pure def extend(lists: List[List[a]], items: List[a]): List[List[a]] =
    lists.foldl([], (out, list) => items.foldl(out, (more, each) => more.append(list.append(each))))

  pure def listsUpTo(items: List[a], most: int): List[List[a]] =
    range(0, most).foldl({ every: [[]], level: [[]] }, (lists, round) => {
      val deeper = extend(lists.level, items)
      { every: lists.every.concat(deeper), level: deeper }
    }).every

  pure val ENV_VALUES: List[Text] = [
    [],
    ["0"],
    ["f", "a", "l", "s", "e"],
    ["F", "A", "L", "S", "E"],
    ["n", "o"],
    ["o", "f", "f"],
    [" ", "O", "f", "F", " "],
    [" ", " "],
    ["<TAB>", "0", "<CR>", "<LF>"],
    ["<VT>", "n", "O", "<FF>"],
    ["<LF>"],
    ["<BOM>", "0"],
    ["<NEL>", "0"],
    ["0", "<NEL>"],
    ["<BOM>"],
    ["1"],
    ["t", "r", "u", "e"],
    ["y", "e", "s"],
    ["2"],
  ]

  pure val ONE_VARIABLE_ENVIRONMENTS: List[str -> Text] = [CI_VARIABLE].concat(AGENT_VARIABLES).foldl([], (envs, name) =>
    ENV_VALUES.foldl(envs, (more, value) => more.append(Map(name -> value))))

  pure val ENVIRONMENTS: List[str -> Text] =
    [Map(), Map("NO_COLOR" -> ["1"])].concat(ONE_VARIABLE_ENVIRONMENTS).append(Map(CI_VARIABLE -> ["0"], "CLAUDECODE" -> ["1"]))

  pure val AUTO_CASES = [true, false].foldl([], (cases, isTerminal) =>
    ENVIRONMENTS.foldl(cases, (more, env) => more.append({ isTerminal: isTerminal, env: env, form: autoForm(isTerminal, env) })))

  pure val NAMES: List[Text] = [
    ["-", "-", "j", "s", "o", "n"],
    ["-", "-", "f", "o", "r", "m", "a", "t"],
    ["-", "f"],
    ["-", "H"],
    ["-", "7"],
    ["-", "-", "n", "o", "-", "c", "o", "l", "o", "r"],
    ["-", "-", "h", "e", "l", "p"],
    ["-", "-", "v", "e", "r", "s", "i", "o", "n"],
    ["-", "-", "c", "u", "r", "s", "o", "r"],
    ["-", "-", "m", "a", "x", "-", "a", "g", "e", "-", "m", "s"],
    ["-", "-", "n", "o", "w"],
    ["-", "-", "b", "r", "o", "k", "e", "n"],
    ["f", "o", "r", "m", "a", "t"],
    ["-", "a", "b"],
    ["-", "-", "a", "-"],
    ["-", "-", "x", "=", "y"],
  ]

  pure val TEXT_VALUE: Text = ["t", "e", "x", "t"]
  pure val JSON_VALUE: Text = ["j", "s", "o", "n"]

  pure val KINDS: List[Kind] = [Switch(Json), Values([]), Values([(TEXT_VALUE, Human), (JSON_VALUE, Json)])]

  pure val OTHERS: List[(Text, str)] = RESERVED_FLAGS.concat([
    (["-", "-", "n", "o", "w"], "the flag alias --now"),
    (["-", "-", "b", "r", "o", "k", "e", "n"], "a flag of the capability probe.read"),
  ])

  pure val ONE_FLAG_CONFIGS: List[List[OutputFlag]] =
    listsUpTo(NAMES, 2).foldl([], (configs, names) => KINDS.foldl(configs, (more, kind) => more.append([{ names: names, kind: kind }])))

  pure val TWO_FLAG_CONFIGS: List[List[OutputFlag]] =
    NAMES.foldl([], (configs, first) => NAMES.foldl(configs, (more, second) =>
      more.append([{ names: [first], kind: Switch(Human) }, { names: [second], kind: Values([(TEXT_VALUE, Human), (JSON_VALUE, Json)]) }])))

  pure val PROBLEM_CASES = ONE_FLAG_CONFIGS.concat(TWO_FLAG_CONFIGS).foldl([], (cases, flags) =>
    cases.append({ flags: flags, others: OTHERS, problems: outputProblems(flags, OTHERS).foldl([], (texts, problem) => texts.append(problemMessage(problem))) }))

  pure val LEVEL_VALUES: List[(Text, Form)] = [(["h", "i", "g", "h"], Human), (["1"], Json), (["2"], Json)]

  pure val CHOICE_FLAGS: List[OutputFlag] = [
    { names: [["-", "-", "j", "s", "o", "n"]], kind: Switch(Json) },
    { names: [["-", "H"], ["-", "-", "h", "u", "m", "a", "n"]], kind: Switch(Human) },
    { names: [["-", "-", "f", "o", "r", "m", "a", "t"], ["-", "f"]], kind: Values([(TEXT_VALUE, Human), (JSON_VALUE, Json)]) },
    { names: [["-", "-", "l", "e", "v", "e", "l"], ["-", "l"]], kind: Values(LEVEL_VALUES) },
  ]

  pure val DEPLOY: Text = ["d", "e", "p", "l", "o", "y"]

  pure val ARGUMENTS: List[Text] = [
    ["-", "-", "j", "s", "o", "n"],
    ["-", "H"],
    ["-", "-", "h", "u", "m", "a", "n"],
    ["-", "-", "f", "o", "r", "m", "a", "t"],
    ["-", "f"],
    TEXT_VALUE,
    JSON_VALUE,
    ["-", "-", "f", "o", "r", "m", "a", "t", "=", "j", "s", "o", "n"],
    ["-", "-", "f", "o", "r", "m", "a", "t", "="],
    ["-", "f", "=", "t", "e", "x", "t"],
    ["-", "-", "j", "s", "o", "n", "="],
    ["-", "-", "j", "s", "o", "n", "=", "1"],
    ["-", "-", "l", "e", "v", "e", "l"],
    ["-", "l"],
    ["h", "i", "g", "h"],
    ["1"],
    ["-", "-", "l", "e", "v", "e", "l", "=", "2"],
    END_OF_FLAGS,
    DEPLOY,
    ["x"],
  ]

  // A smaller set for the lists of 3 arguments, for example an application command in the second place.
  pure val THREE_ARGUMENTS: List[Text] = [
    ["-", "-", "j", "s", "o", "n"],
    ["-", "-", "f", "o", "r", "m", "a", "t"],
    ["-", "f"],
    TEXT_VALUE,
    ["-", "-", "l", "e", "v", "e", "l"],
    END_OF_FLAGS,
    DEPLOY,
    ["x"],
  ]

  pure val ARGUMENT_LISTS: List[List[Text]] = listsUpTo(ARGUMENTS, 2).concat(extend(extend(extend([[]], THREE_ARGUMENTS), THREE_ARGUMENTS), THREE_ARGUMENTS))

  pure val CHOICE_CASES = [[], [DEPLOY]].foldl([], (cases, commands) =>
    ARGUMENT_LISTS.foldl(cases, (more, args) => {
      val outcome = outputChoice(CHOICE_FLAGS, args, commands)
      more.append({ flags: CHOICE_FLAGS, args: args, commands: commands, outcome: outcome, message: outcomeMessage(outcome) })
    }))

  pure val DECIDE_ENVIRONMENTS: List[str -> Text] = [Map(), Map(CI_VARIABLE -> ["1"]), Map("CLAUDECODE" -> ["<TAB>", "0"]), Map("CODEX_THREAD_ID" -> ["t", "1"])]

  pure val DECIDE_ARGUMENTS: List[List[Text]] = [
    [],
    [["-", "-", "j", "s", "o", "n"]],
    [["-", "H"]],
    [["-", "-", "f", "o", "r", "m", "a", "t"], TEXT_VALUE],
    [["-", "f"]],
    [["-", "l"], ["3"]],
  ]

  pure val DECIDE_CASES = [AutoDefault, JsonDefault].foldl([], (cases, fallback) =>
    [true, false].foldl(cases, (byTerminal, isTerminal) =>
      DECIDE_ENVIRONMENTS.foldl(byTerminal, (byEnv, env) =>
        DECIDE_ARGUMENTS.foldl(byEnv, (more, args) => {
          val result = decide(fallback, isTerminal, env, outputChoice(CHOICE_FLAGS, args, []))
          more.append({ fallback: fallback, isTerminal: isTerminal, env: env, args: args, result: result, message: runMessage(result) })
        }))))

  pure val HELP_FLAGS: List[OutputFlag] = CHOICE_FLAGS.concat([
    { names: [["-", "-", "c", "o", "l", "o", "r"]], kind: Values([(["b"], Human), (["a", "-", "b"], Json), (["a"], Json), (["B"], Human), (["1", "0"], Json), (["9"], Human)]) },
    { names: [["-", "-", "p", "l", "a", "i", "n"], ["-", "p"], ["-", "P"]], kind: Switch(Human) },
    { names: [["-", "o"]], kind: Values([(TEXT_VALUE, Human)]) },
  ])

  pure val HELP_CASES = HELP_FLAGS.foldl([], (cases, flag) => cases.append({ flag: flag, line: helpLine(flag) }))

  var data: {
    ciVariable: str,
    agentVariables: List[str],
    falseValues: List[Text],
    trimCharacters: List[str],
    programFlags: List[Text],
    resumeFlags: List[Text],
    reservedFlags: List[(Text, str)],
    invalidInputExitCode: int,
    messages: {
      noName: Text, badName: Text, sameAsOutputFlag: Text, sameAsOther: Text, noValues: Text, badValue: Text,
      switchHelp: Text, valuesHelp: Text, meaning: Text,
    },
    formNames: { human: Text, json: Text },
    list: { separator: Text, orWord: Text, andWord: Text, names: Text, values: Text },
  }

  var autoCases: List[{ isTerminal: bool, env: str -> Text, form: Form }]

  var problemCases: List[{ flags: List[OutputFlag], others: List[(Text, str)], problems: List[Text] }]

  var choiceCases: List[{ flags: List[OutputFlag], args: List[Text], commands: List[Text], outcome: Outcome, message: Text }]

  var decideCases: List[{ fallback: Default, isTerminal: bool, env: str -> Text, args: List[Text], result: Run, message: Text }]

  var helpCases: List[{ flag: OutputFlag, line: Text }]

  action init = all {
    data' = {
      ciVariable: CI_VARIABLE,
      agentVariables: AGENT_VARIABLES,
      falseValues: FALSE_VALUES,
      trimCharacters: TRIM_CHARACTERS,
      programFlags: PROGRAM_FLAGS,
      resumeFlags: RESUME_FLAGS,
      reservedFlags: RESERVED_FLAGS,
      invalidInputExitCode: INVALID_INPUT_EXIT_CODE,
      messages: MESSAGES,
      formNames: { human: formName(Human), json: formName(Json) },
      list: { separator: LIST_SEPARATOR, orWord: OR_WORD, andWord: AND_WORD, names: NAME_SEPARATOR, values: VALUE_SEPARATOR },
    },
    autoCases' = AUTO_CASES,
    problemCases' = PROBLEM_CASES,
    choiceCases' = CHOICE_CASES,
    decideCases' = DECIDE_CASES,
    helpCases' = HELP_CASES,
  }

  action step = all {
    data' = data,
    autoCases' = autoCases,
    problemCases' = problemCases,
    choiceCases' = choiceCases,
    decideCases' = decideCases,
    helpCases' = helpCases,
  }
}
