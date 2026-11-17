// Quint has no operations on strings. A text that a rule reads character by character is a list of characters.
module cliOutput {
  type Text = List[str]

  type Form = Human | Json

  type Default = AutoDefault | JsonDefault

  type Kind = Switch(Form) | Values(List[(Text, Form)])

  type OutputFlag = { names: List[Text], kind: Kind }

  type Problem =
    | NoName
    | BadName(Text)
    | SameAsOutputFlag(Text)
    | SameAsOther((Text, str))
    | NoValues(Text)

  type Chosen = ByDefault | ByFlag(Form)

  type Outcome =
    | Parsed({ chosen: Chosen, rest: List[Text] })
    | BadValue({ flag: Text, values: List[Text] })

  type Run =
    | Proceeds({ form: Form, rest: List[Text] })
    | Stops({ exitCode: int, flag: Text, values: List[Text] })

  pure val CI_VARIABLE = "CI"

  pure val AGENT_VARIABLES = [
    "AI_AGENT",
    "CLAUDECODE",
    "CODEX_THREAD_ID",
    "CURSOR_AGENT",
    "GEMINI_CLI",
    "OPENCODE",
    "AMP_CURRENT_THREAD_ID",
    "AUGMENT_AGENT",
    "QWEN_CODE_SESSION_ID",
    "PI_CODING_AGENT",
    "CRUSH",
    "COPILOT_AGENT",
  ]

  pure val FALSE_VALUES: List[Text] = [
    [],
    ["0"],
    ["f", "a", "l", "s", "e"],
    ["n", "o"],
    ["o", "f", "f"],
  ]

  pure val RESERVED_FLAGS: List[(Text, str)] = [
    (["-", "-", "h", "e", "l", "p"], "the flag --help"),
    (["-", "-", "v", "e", "r", "s", "i", "o", "n"], "the flag --version"),
    (["-", "-", "c", "u", "r", "s", "o", "r"], "the flag --cursor of watch"),
    (["-", "-", "m", "a", "x", "-", "a", "g", "e", "-", "m", "s"], "the flag --max-age-ms of watch"),
  ]

  pure val END_OF_FLAGS: Text = ["-", "-"]

  pure val INVALID_INPUT_EXIT_CODE = 3

  pure val MESSAGES = {
    noName: "An output flag has no name.",
    badName: "The output flag {name} is not a valid name. Give --<word> or -<letter or digit>.",
    sameAsOutputFlag: "The output flag {name} has the same name as another output flag.",
    sameAsOther: "The output flag {name} has the same name as {other}.",
    noValues: "The output flag {name} has no values.",
    badValue: "The option {name} must be {values}.",
  }

  pure val WHITESPACE = Set(" ")

  pure val UPPER_TO_LOWER = Map(
    "A" -> "a", "B" -> "b", "C" -> "c", "D" -> "d", "E" -> "e", "F" -> "f", "G" -> "g", "H" -> "h", "I" -> "i",
    "J" -> "j", "K" -> "k", "L" -> "l", "M" -> "m", "N" -> "n", "O" -> "o", "P" -> "p", "Q" -> "q", "R" -> "r",
    "S" -> "s", "T" -> "t", "U" -> "u", "V" -> "v", "W" -> "w", "X" -> "x", "Y" -> "y", "Z" -> "z",
  )

  pure val LOWER_LETTERS = UPPER_TO_LOWER.keys().map(upper => UPPER_TO_LOWER.get(upper))

  pure val LETTERS = UPPER_TO_LOWER.keys().union(LOWER_LETTERS)

  pure val DIGITS = Set("0", "1", "2", "3", "4", "5", "6", "7", "8", "9")

  pure def includes(list: List[a], wanted: a): bool = list.foldl(false, (found, each) => found or each == wanted)

  pure def smallest(numbers: Set[int], otherwise: int): int = numbers.fold(otherwise, (least, n) => if (n < least) n else least)

  pure def largest(numbers: Set[int], otherwise: int): int = numbers.fold(otherwise, (most, n) => if (n > most) n else most)

  pure def trim(text: Text): Text = {
    val kept = text.indices().filter(i => not(WHITESPACE.contains(text[i])))
    if (kept == Set()) [] else text.slice(smallest(kept, text.length()), largest(kept, 0) + 1)
  }

  pure def lowercase(text: Text): Text =
    text.foldl([], (lower, c) => lower.append(if (UPPER_TO_LOWER.keys().contains(c)) UPPER_TO_LOWER.get(c) else c))

  pure def isTruthy(env: str -> Text, name: str): bool =
    env.keys().contains(name) and not(includes(FALSE_VALUES, lowercase(trim(env.get(name)))))

  pure def autoForm(isTerminal: bool, env: str -> Text): Form =
    if (isTerminal and not(isTruthy(env, CI_VARIABLE)) and not(AGENT_VARIABLES.foldl(false, (found, name) => found or isTruthy(env, name))))
      Human
    else
      Json

  pure def startsWithDoubleDash(text: Text): bool = text.length() >= 2 and text[0] == "-" and text[1] == "-"

  pure def isLongName(name: Text): bool =
    name.length() >= 3 and startsWithDoubleDash(name) and LOWER_LETTERS.contains(name[2])
      and name.indices().forall(i => i < 2 or LOWER_LETTERS.contains(name[i]) or DIGITS.contains(name[i]) or name[i] == "-")
      and name.indices().forall(i => i < 2 or name[i] != "-" or (i + 1 < name.length() and name[i + 1] != "-"))

  pure def isShortName(name: Text): bool =
    name.length() == 2 and name[0] == "-" and (LETTERS.contains(name[1]) or DIGITS.contains(name[1]))

  pure def isName(name: Text): bool = isLongName(name) or isShortName(name)

  type Taken = Free | TakenBy(str)

  pure def takenBy(others: List[(Text, str)], name: Text): Taken =
    others.foldl(Free, (found, other) => match found {
      | Free => if (other._1 == name) TakenBy(other._2) else Free
      | TakenBy(what) => TakenBy(what)
    })

  pure def valueNames(values: List[(Text, Form)]): List[Text] = values.foldl([], (names, value) => names.append(value._1))

  pure def outputProblems(flags: List[OutputFlag], others: List[(Text, str)]): List[Problem] = {
    val checked = flags.foldl({ problems: [], seen: Set() }, (state, flag) => {
      val withNoName = if (flag.names.length() == 0) { ...state, problems: state.problems.append(NoName) } else state
      val named = flag.names.foldl(withNoName, (inner, name) =>
        if (not(isName(name)))
          { ...inner, problems: inner.problems.append(BadName(name)) }
        else {
          val duplicate = if (inner.seen.contains(name)) [SameAsOutputFlag(name)] else []
          val clash = match takenBy(others, name) {
            | Free => []
            | TakenBy(what) => [SameAsOther((name, what))]
          }
          { problems: inner.problems.concat(duplicate).concat(clash), seen: inner.seen.union(Set(name)) }
        }
      )
      match flag.kind {
        | Values(values) =>
          if (flag.names.length() > 0 and values.length() == 0) { ...named, problems: named.problems.append(NoValues(flag.names[0])) } else named
        | Switch(_) => named
      }
    })
    checked.problems
  }

  type InlineValue = NoInline | InlineGiven(Text)

  pure def split(arg: Text): { name: Text, inline: InlineValue } = {
    val equals = arg.indices().filter(i => arg[i] == "=")
    if (startsWithDoubleDash(arg) and equals != Set()) {
      val at = smallest(equals, arg.length())
      { name: arg.slice(0, at), inline: InlineGiven(arg.slice(at + 1, arg.length())) }
    } else {
      { name: arg, inline: NoInline }
    }
  }

  type FlagMatch = NoFlag | FlagFound(Kind)

  pure def flagNamed(flags: List[OutputFlag], name: Text): FlagMatch =
    flags.foldl(NoFlag, (found, flag) => match found {
      | NoFlag => if (includes(flag.names, name)) FlagFound(flag.kind) else NoFlag
      | FlagFound(kind) => FlagFound(kind)
    })

  type ValueMatch = NoValue | ValueFound(Form)

  pure def formOfValue(values: List[(Text, Form)], value: Text): ValueMatch =
    values.foldl(NoValue, (found, each) => match found {
      | NoValue => if (each._1 == value) ValueFound(each._2) else NoValue
      | ValueFound(form) => ValueFound(form)
    })

  type Awaiting = NotAwaiting | AwaitingValue({ flag: Text, values: List[(Text, Form)] })

  type Failure = NoFailure | Failed({ flag: Text, values: List[Text] })

  type Reading = { rest: List[Text], chosen: Chosen, stopped: bool, awaiting: Awaiting, failure: Failure }

  pure def take(reading: Reading, flag: Text, values: List[(Text, Form)], value: Text): Reading =
    match formOfValue(values, value) {
      | ValueFound(form) => { ...reading, chosen: ByFlag(form), awaiting: NotAwaiting }
      | NoValue => { ...reading, awaiting: NotAwaiting, failure: Failed({ flag: flag, values: valueNames(values) }) }
    }

  pure def read(flags: List[OutputFlag], commands: List[Text], reading: Reading, arg: Text): Reading =
    if (reading.failure != NoFailure) reading
    else if (reading.stopped) { ...reading, rest: reading.rest.append(arg) }
    else match reading.awaiting {
      | AwaitingValue(pending) => take(reading, pending.flag, pending.values, arg)
      | NotAwaiting =>
        if (arg == END_OF_FLAGS or (reading.rest.length() == 0 and includes(commands, arg)))
          { ...reading, rest: reading.rest.append(arg), stopped: true }
        else {
          val parts = split(arg)
          match flagNamed(flags, parts.name) {
            | NoFlag => { ...reading, rest: reading.rest.append(arg) }
            | FlagFound(kind) => match kind {
              | Switch(form) => match parts.inline {
                | NoInline => { ...reading, chosen: ByFlag(form) }
                | InlineGiven(_) => { ...reading, rest: reading.rest.append(arg) }
              }
              | Values(values) => match parts.inline {
                | InlineGiven(value) => take(reading, parts.name, values, value)
                | NoInline => { ...reading, awaiting: AwaitingValue({ flag: parts.name, values: values }) }
              }
            }
          }
        }
    }

  pure def outputChoice(flags: List[OutputFlag], args: List[Text], commands: List[Text]): Outcome = {
    val start = { rest: [], chosen: ByDefault, stopped: false, awaiting: NotAwaiting, failure: NoFailure }
    val reading = args.foldl(start, (state, arg) => read(flags, commands, state, arg))
    match reading.failure {
      | Failed(failure) => BadValue(failure)
      | NoFailure => match reading.awaiting {
        | AwaitingValue(pending) => BadValue({ flag: pending.flag, values: valueNames(pending.values) })
        | NotAwaiting => Parsed({ chosen: reading.chosen, rest: reading.rest })
      }
    }
  }

  pure def decide(fallback: Default, isTerminal: bool, env: str -> Text, outcome: Outcome): Run =
    match outcome {
      | BadValue(failure) => Stops({ exitCode: INVALID_INPUT_EXIT_CODE, flag: failure.flag, values: failure.values })
      | Parsed(parsed) => match parsed.chosen {
        | ByFlag(form) => Proceeds({ form: form, rest: parsed.rest })
        | ByDefault => Proceeds({ form: if (fallback == AutoDefault) autoForm(isTerminal, env) else Json, rest: parsed.rest })
      }
    }

  pure val JSON_FLAG: Text = ["-", "-", "j", "s", "o", "n"]
  pure val FORMAT_FLAG: Text = ["-", "-", "f", "o", "r", "m", "a", "t"]
  pure val F_FLAG: Text = ["-", "f"]
  pure val TEXT: Text = ["t", "e", "x", "t"]
  pure val JSON: Text = ["j", "s", "o", "n"]
  pure val FLAGS = [
    { names: [JSON_FLAG], kind: Switch(Json) },
    { names: [FORMAT_FLAG, F_FLAG], kind: Values([(TEXT, Human), (JSON, Json)]) },
  ]

  run autoFormTest = all {
    assert(autoForm(true, Map()) == Human),
    assert(autoForm(false, Map()) == Json),
    assert(autoForm(true, Map("CLAUDECODE" -> ["1"])) == Json),
    assert(autoForm(true, Map("CLAUDECODE" -> [" ", "O", "f", "F"])) == Human),
    assert(autoForm(true, Map("CI" -> ["t", "r", "u", "e"])) == Json),
    assert(autoForm(true, Map("CI" -> [])) == Human),
  }

  run namesTest = all {
    assert(isName(JSON_FLAG)),
    assert(isName(["-", "-", "n", "o", "-", "c", "o", "l", "o", "r", "2"])),
    assert(isName(["-", "H"])),
    assert(not(isName(["-", "-", "n", "o", "-"]))),
    assert(not(isName(["-", "-", "a", "-", "-", "b"]))),
    assert(not(isName(["-", "-", "1", "a"]))),
    assert(not(isName(["-", "a", "b"]))),
    assert(not(isName(["j", "s", "o", "n"]))),
    assert(not(isName(END_OF_FLAGS))),
  }

  run problemsTest = all {
    assert(outputProblems(FLAGS, RESERVED_FLAGS) == []),
    assert(outputProblems([{ names: [], kind: Values([]) }], []) == [NoName]),
    assert(outputProblems([{ names: [JSON], kind: Values([]) }], []) == [BadName(JSON), NoValues(JSON)]),
    assert(outputProblems([{ names: [JSON_FLAG, JSON_FLAG], kind: Switch(Json) }], [(JSON_FLAG, "the flag alias --json")])
      == [SameAsOther((JSON_FLAG, "the flag alias --json")), SameAsOutputFlag(JSON_FLAG), SameAsOther((JSON_FLAG, "the flag alias --json"))]),
  }

  run choiceTest = all {
    val deploy = ["d", "e", "p", "l", "o", "y"]
    val x = ["x"]
    all {
      assert(outputChoice(FLAGS, [x, JSON_FLAG, x], []) == Parsed({ chosen: ByFlag(Json), rest: [x, x] })),
      assert(outputChoice(FLAGS, [F_FLAG, TEXT, JSON_FLAG], []) == Parsed({ chosen: ByFlag(Json), rest: [] })),
      assert(outputChoice(FLAGS, [JSON_FLAG, ["-", "-", "f", "o", "r", "m", "a", "t", "=", "t", "e", "x", "t"]], []) == Parsed({ chosen: ByFlag(Human), rest: [] })),
      assert(outputChoice(FLAGS, [JSON_FLAG, END_OF_FLAGS, F_FLAG], []) == Parsed({ chosen: ByFlag(Json), rest: [END_OF_FLAGS, F_FLAG] })),
      assert(outputChoice(FLAGS, [deploy, F_FLAG], [deploy]) == Parsed({ chosen: ByDefault, rest: [deploy, F_FLAG] })),
      assert(outputChoice(FLAGS, [x, deploy, JSON_FLAG], [deploy]) == Parsed({ chosen: ByFlag(Json), rest: [x, deploy] })),
      assert(outputChoice(FLAGS, [["-", "-", "j", "s", "o", "n", "=", "1"]], []) == Parsed({ chosen: ByDefault, rest: [["-", "-", "j", "s", "o", "n", "=", "1"]] })),
      assert(outputChoice(FLAGS, [F_FLAG], []) == BadValue({ flag: F_FLAG, values: [TEXT, JSON] })),
      assert(outputChoice(FLAGS, [F_FLAG, x, JSON_FLAG], []) == BadValue({ flag: F_FLAG, values: [TEXT, JSON] })),
      assert(outputChoice(FLAGS, [["-", "f", "=", "t", "e", "x", "t"]], []) == Parsed({ chosen: ByDefault, rest: [["-", "f", "=", "t", "e", "x", "t"]] })),
    }
  }

  run decideTest = all {
    assert(decide(JsonDefault, true, Map(), outputChoice(FLAGS, [], [])) == Proceeds({ form: Json, rest: [] })),
    assert(decide(AutoDefault, true, Map(), outputChoice(FLAGS, [], [])) == Proceeds({ form: Human, rest: [] })),
    assert(decide(AutoDefault, true, Map(), outputChoice(FLAGS, [F_FLAG], [])) == Stops({ exitCode: 3, flag: F_FLAG, values: [TEXT, JSON] })),
  }
}
