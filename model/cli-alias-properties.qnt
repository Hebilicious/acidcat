module cliAliasNames {
  import cliAliases.* from "./cli-aliases"

  pure val NAMES: Set[Text] = Set(
    ["s"],
    ["s", " ", "t"],
    ["l", "i", "s", "t", " ", "t"],
    ["w", "a", "t", "c", "h"],
    ["p", " ", "t"],
    ["p", " ", "r"],
    ["p"],
    ["s", " ", " ", "t"],
    [" ", "s"],
    ["s", " "],
    ["s", " ", "t", " ", "u"],
    ["-", "-", "s"],
    ["-", "-", "s", " ", "t"],
    ["-", "-", "h", "e", "l", "p"],
  )

  pure val ID: Text = ["p", ".", "r"]
  pure val CAPABILITIES: List[Entry] = [{ id: ID, inView: true, input: Properties([["x"]]) }]
  pure val VALUE: AliasValue = AliasObject({ capability: Id(ID), event: Absent, input: NoFixedInput, others: [] })

  var name: Text
  var checked: Checked

  action init = {
    nondet chosen = NAMES.oneOf()
    all {
      name' = chosen,
      checked' = checkAlias(CAPABILITIES, [], chosen, VALUE),
    }
  }

  action step = all {
    name' = name,
    checked' = checked,
  }

  pure def spaces(name: Text): int = name.foldl(0, (count, c) => if (c == " ") count + 1 else count)

  pure def beforeSpace(name: Text): Text =
    name.foldl({ word: [], done: false }, (state, c) =>
      if (state.done or c == " ") { word: state.word, done: true } else { word: state.word.append(c), done: false }
    ).word

  val acceptedAliasNamesAreSafe = {
    val leading = beforeSpace(name)
    match checked {
      | Rejected(_) => true
      | Accepted(_) => and {
        name[0] != " ",
        name[name.length() - 1] != " ",
        spaces(name) <= (if (startsWithDoubleDash(name)) 0 else 1),
        not(CLI_GENERIC_COMMANDS.includes(leading)),
        not(PROGRAM_FLAGS.includes(leading)),
        name != pathOf(ID),
      }
    }
  }
}
