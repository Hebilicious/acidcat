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
    cases.append({ flags: flags, others: OTHERS, problems: outputProblems(flags, OTHERS) }))

  pure val CHOICE_FLAGS: List[OutputFlag] = [
    { names: [["-", "-", "j", "s", "o", "n"]], kind: Switch(Json) },
    { names: [["-", "H"], ["-", "-", "h", "u", "m", "a", "n"]], kind: Switch(Human) },
    { names: [["-", "-", "f", "o", "r", "m", "a", "t"], ["-", "f"]], kind: Values([(TEXT_VALUE, Human), (JSON_VALUE, Json)]) },
  ]

  pure val DEPLOY: Text = ["d", "e", "p", "l", "o", "y"]

  pure val ARGUMENTS: List[Text] = [
    ["-", "-", "j", "s", "o", "n"],
    ["-", "H"],
    ["-", "f"],
    TEXT_VALUE,
    ["-", "-", "f", "o", "r", "m", "a", "t", "=", "j", "s", "o", "n"],
    ["-", "-", "f", "o", "r", "m", "a", "t", "="],
    ["-", "-", "j", "s", "o", "n", "=", "1"],
    END_OF_FLAGS,
    DEPLOY,
    ["x"],
  ]

  pure val CHOICE_CASES = [[], [DEPLOY]].foldl([], (cases, commands) =>
    listsUpTo(ARGUMENTS, 3).foldl(cases, (more, args) =>
      more.append({ flags: CHOICE_FLAGS, args: args, commands: commands, outcome: outputChoice(CHOICE_FLAGS, args, commands) })))

  var data: {
    ciVariable: str,
    agentVariables: List[str],
    falseValues: List[Text],
    reservedFlags: List[(Text, str)],
    invalidInputExitCode: int,
    messages: { noName: str, badName: str, sameAsOutputFlag: str, sameAsOther: str, noValues: str, badValue: str },
  }

  var autoCases: List[{ isTerminal: bool, env: str -> Text, form: Form }]

  var problemCases: List[{ flags: List[OutputFlag], others: List[(Text, str)], problems: List[Problem] }]

  var choiceCases: List[{ flags: List[OutputFlag], args: List[Text], commands: List[Text], outcome: Outcome }]

  action init = all {
    data' = {
      ciVariable: CI_VARIABLE,
      agentVariables: AGENT_VARIABLES,
      falseValues: FALSE_VALUES,
      reservedFlags: RESERVED_FLAGS,
      invalidInputExitCode: INVALID_INPUT_EXIT_CODE,
      messages: MESSAGES,
    },
    autoCases' = AUTO_CASES,
    problemCases' = PROBLEM_CASES,
    choiceCases' = CHOICE_CASES,
  }

  action step = all {
    data' = data,
    autoCases' = autoCases,
    problemCases' = problemCases,
    choiceCases' = choiceCases,
  }
}
