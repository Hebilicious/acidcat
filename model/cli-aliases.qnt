// The checks of the aliases of a target, in options.cli of the target (spec/bindings/cli.md#aliases).
// A name, an id or a property is a list of characters. A problem has the key of its template in ALIAS_MESSAGES, and
// the parts that fill the template, except {where}: the generator writes "target <name>".
module cliAliases {
  import cliOutput.* from "./cli-output"
  export cliOutput.*

  type Member = Absent | Null | NotText | Id(Text)

  type FixedInput = NoFixedInput | FixedNotObject | FixedKeys(List[Text])

  type AliasValue =
    | NotObject
    | AliasObject({ capability: Member, event: Member, input: FixedInput, others: List[Text] })

  type Schema = NoSchema | NoProperties | Properties(List[Text])

  type Entry = { id: Text, inView: bool, input: Schema }

  type DefaultSetting = NoDefault | DefaultNotText | DefaultName(Text)

  type AliasSet = AliasesAbsent | AliasesNotObject | AliasMembers(List[(Text, AliasValue)])

  type Settings = NoSettings | SettingsNotObject | SettingsObject({ aliases: AliasSet, default: DefaultSetting })

  type Declared = { cliBinding: bool, settings: Settings }

  type AliasProblem = { key: str, parts: List[(str, Text)] }

  type AliasKind = CapabilityAlias | EventAlias

  type Alias = { name: Text, kind: AliasKind, id: Text, input: FixedInput }

  type Fallback = NoDefaultAlias | DefaultAlias(Text)

  type Result = { problems: List[AliasProblem], aliases: List[Alias], default: Fallback }

  pure def isWord(word: Text): bool =
    word.length() > 0 and LOWER_LETTERS.contains(word[0]) and word.indices().forall(i =>
      LOWER_LETTERS.contains(word[i]) or DIGITS.contains(word[i]) or (word[i] == "-" and i + 1 < word.length() and word[i + 1] != "-"))

  pure def withoutDashes(name: Text): Text = name.slice(2, name.length())

  pure def wordsOf(name: Text): List[Text] =
    name.foldl([[]], (words, c) =>
      if (c == " ") words.append([]) else words.replaceAt(words.length() - 1, words[words.length() - 1].append(c)))

  pure def isAliasName(name: Text): bool =
    if (startsWithDoubleDash(name)) isWord(withoutDashes(name))
    else wordsOf(name).length() <= 2 and wordsOf(name).foldl(true, (valid, word) => valid and isWord(word))

  pure def leadingWord(name: Text): Text = if (startsWithDoubleDash(name)) name else wordsOf(name)[0]

  pure def isTwoWords(name: Text): bool = not(startsWithDoubleDash(name)) and wordsOf(name).length() == 2

  pure def pathOf(id: Text): Text = id.foldl([], (path, c) => path.append(if (c == ".") " " else c))

  pure def startsWithXDash(name: Text): bool = name.length() >= 2 and name[0] == "x" and name[1] == "-"

  pure def isReserved(name: Text): bool =
    if (startsWithDoubleDash(name)) PROGRAM_FLAGS.includes(name) else CLI_GENERIC_COMMANDS.includes(name)

  pure def entryOf(entries: List[Entry], id: Text): List[Entry] = entries.select(entry => entry.inView and entry.id == id)

  pure def propertiesOf(schema: Schema): List[Text] = match schema {
    | Properties(names) => names
    | _ => []
  }

  pure def problem(key: str, name: Text, parts: List[(str, Text)]): AliasProblem = { key: key, parts: [("name", name)].concat(parts) }

  pure val A_CAPABILITY: Text = ["a capability"]
  pure val AN_EVENT: Text = ["an event"]
  pure val MEMBER_SEPARATOR: Text = [", "]

  type Checked = Rejected(AliasProblem) | Accepted(Alias)

  pure def checkAlias(capabilities: List[Entry], events: List[Entry], name: Text, value: AliasValue): Checked = {
    val paths = capabilities.select(entry => entry.inView).foldl([], (found, entry) => found.append(pathOf(entry.id)))
    val leading = leadingWord(name)
    if (not(isAliasName(name))) Rejected(problem("badName", name, []))
    else if (isReserved(leading)) Rejected(problem(if (isTwoWords(name)) "reservedFirstWord" else "reservedName", name, []))
    else if (paths.includes(name)) Rejected(problem("commandPath", name, []))
    else match value {
      | NotObject => Rejected(problem("badTarget", name, []))
      | AliasObject(alias) => {
        val chosen = match alias.capability { | Absent => alias.event | Null => alias.event | _ => alias.capability }
        val chosenId = match chosen { | Id(id) => [id] | _ => [] }
        if (chosenId == [] or (alias.capability != Absent and alias.event != Absent)) Rejected(problem("badTarget", name, []))
        else {
          val id = chosenId[0]
          val unknown = alias.others.select(other => not(startsWithXDash(other)))
          val kind = if (alias.event != Absent) EventAlias else CapabilityAlias
          val found = entryOf(if (kind == EventAlias) events else capabilities, id)
          if (unknown != []) Rejected(problem("unknownMember", name, [("members", joinedWith(unknown, MEMBER_SEPARATOR))]))
          else if (found == []) Rejected(problem("notInView", name, [("id", id), ("kind", if (kind == EventAlias) AN_EVENT else A_CAPABILITY)]))
          else match alias.input {
            | NoFixedInput => Accepted({ name: name, kind: kind, id: id, input: NoFixedInput })
            | FixedNotObject => Rejected(problem("inputNotObject", name, []))
            | FixedKeys(fixedKeys) => match found[0].input {
              | Properties(properties) => {
                val extra = fixedKeys.select(key => not(properties.includes(key)))
                if (extra != []) Rejected(problem("notAProperty", name, [("members", joinedWith(extra, MEMBER_SEPARATOR)), ("id", id)]))
                else Accepted({ name: name, kind: kind, id: id, input: alias.input })
              }
              | _ => Rejected(problem("noProperties", name, [("id", id)]))
            }
          }
        }
      }
    }
  }

  pure def fixedKeysOf(input: FixedInput): List[Text] = match input {
    | FixedKeys(names) => names
    | _ => []
  }

  pure def flagsOf(capabilities: List[Entry], events: List[Entry], alias: Alias): List[Text] = {
    val fixed = fixedKeysOf(alias.input)
    val entries = entryOf(if (alias.kind == EventAlias) events else capabilities, alias.id)
    val properties = entries.foldl([], (found, entry) => found.concat(propertiesOf(entry.input))).select(property => not(fixed.includes(property)))
    properties.concat(if (alias.kind == EventAlias) RESUME_FLAGS.foldl([], (words, flag) => words.append(withoutDashes(flag))) else [])
  }

  pure def defaultProblems(capabilities: List[Entry], events: List[Entry], aliases: List[Alias], fallback: Alias): List[AliasProblem] = {
    val flags = flagsOf(capabilities, events, fallback)
    val reserved = PROGRAM_FLAGS.select(flag => flags.includes(withoutDashes(flag))).foldl([], (problems, flag) =>
      problems.append({ key: "defaultHasReservedFlag", parts: [("name", fallback.name), ("flag", flag)] }))
    val shadowed = aliases.select(alias => startsWithDoubleDash(alias.name) and flags.includes(withoutDashes(alias.name))).foldl([], (problems, alias) =>
      problems.append({ key: "flagOfDefault", parts: [("name", alias.name), ("default", fallback.name)] }))
    reserved.concat(shadowed)
  }

  pure val NO_RESULT: Result = { problems: [], aliases: [], default: NoDefaultAlias }

  pure def aliasesOf(capabilities: List[Entry], events: List[Entry], declared: Declared): Result = match declared.settings {
    | NoSettings => NO_RESULT
    | SettingsNotObject => { ...NO_RESULT, problems: [{ key: "settingsNotObject", parts: [] }] }
    | SettingsObject(settings) => {
      val binding = if (declared.cliBinding) [] else [{ key: "noCliBinding", parts: [] }]
      val members = match settings.aliases { | AliasMembers(members) => [members] | AliasesAbsent => [[]] | AliasesNotObject => [] }
      if (members == []) { ...NO_RESULT, problems: binding.append({ key: "aliasesNotObject", parts: [] }) }
      else {
        val sorted = inCodePointOrder(members[0], member => member._1)
        val names = sorted.foldl([], (found, member) => found.append(member._1))
        val checked = sorted.foldl({ problems: binding, aliases: [] }, (state, member) => match checkAlias(capabilities, events, member._1, member._2) {
          | Rejected(found) => { ...state, problems: state.problems.append(found) }
          | Accepted(alias) => { ...state, aliases: state.aliases.append(alias) }
        })
        val done = { problems: checked.problems, aliases: checked.aliases, default: NoDefaultAlias }
        val badDefault = { ...done, problems: done.problems.append({ key: "badDefault", parts: [] }) }
        match settings.default {
          | NoDefault => done
          | DefaultNotText => badDefault
          | DefaultName(named) =>
            if (startsWithDoubleDash(named) or not(names.includes(named))) badDefault
            else {
              val fallback = checked.aliases.select(alias => alias.name == named)
              if (fallback == []) done
              else {
                ...done,
                problems: done.problems.concat(defaultProblems(capabilities, events, checked.aliases, fallback[0])),
                default: DefaultAlias(named),
              }
            }
        }
      }
    }
  }

  pure val READ: Text = ["p", "r", "o", "b", "e", ".", "r", "e", "a", "d"]
  pure val PATH: Text = ["p", "a", "t", "h"]
  pure val HELP: Text = ["h", "e", "l", "p"]
  pure val TEST_CAPABILITIES: List[Entry] = [{ id: READ, inView: true, input: Properties([PATH, HELP]) }]

  pure def capabilityAlias(id: Text, input: FixedInput): AliasValue =
    AliasObject({ capability: Id(id), event: Absent, input: input, others: [] })

  run aliasNamesTest = all {
    assert(isAliasName(["s", "t", "a", "t", "u", "s"])),
    assert(isAliasName(["-", "-", "o", "n", "-", "2"])),
    assert(not(isAliasName(["-", "-"]))),
    assert(not(isAliasName(["a", "-", "-", "b"]))),
    assert(not(isAliasName(["a", "-"]))),
    assert(not(isAliasName(["B"]))),
    assert(not(isAliasName(["-", "x"]))),
    assert(isAliasName(["i", "n", " ", "a", "d", "o", "p", "t"])),
    assert(not(isAliasName(["a", " ", "b", " ", "c"]))),
    assert(not(isAliasName(["a", " ", " ", "b"]))),
    assert(not(isAliasName([" ", "a"]))),
    assert(not(isAliasName(["a", " "]))),
    assert(not(isAliasName(["-", "-", "a", " ", "b"]))),
    assert(leadingWord(["i", "n", " ", "a"]) == ["i", "n"]),
    assert(pathOf(READ) == ["p", "r", "o", "b", "e", " ", "r", "e", "a", "d"]),
  }

  pure def declaredWith(aliases: List[(Text, AliasValue)], fallback: DefaultSetting): Declared =
    { cliBinding: true, settings: SettingsObject({ aliases: AliasMembers(aliases), default: fallback }) }

  run aliasesTest = {
    val status = ["s", "t", "a", "t", "u", "s"]
    all {
      assert(aliasesOf(TEST_CAPABILITIES, [], { cliBinding: true, settings: NoSettings }) == NO_RESULT),
      assert(aliasesOf(TEST_CAPABILITIES, [], declaredWith([(status, capabilityAlias(READ, NoFixedInput))], DefaultName(status))) == {
        problems: [{ key: "defaultHasReservedFlag", parts: [("name", status), ("flag", ["-", "-", "h", "e", "l", "p"])] }],
        aliases: [{ name: status, kind: CapabilityAlias, id: READ, input: NoFixedInput }],
        default: DefaultAlias(status),
      }),
      assert(aliasesOf(TEST_CAPABILITIES, [], declaredWith([(status, capabilityAlias(READ, FixedKeys([HELP])))], DefaultName(status))).problems == []),
      assert(aliasesOf(TEST_CAPABILITIES, [], declaredWith([(["p", "r", "o", "b", "e"], capabilityAlias(READ, NoFixedInput))], NoDefault)).problems == []),
      assert(aliasesOf(TEST_CAPABILITIES, [], declaredWith([(pathOf(READ), capabilityAlias(READ, NoFixedInput))], NoDefault)).problems ==
        [problem("commandPath", pathOf(READ), [])]),
      assert(aliasesOf(TEST_CAPABILITIES, [], declaredWith([], DefaultName(status))).problems == [{ key: "badDefault", parts: [] }]),
      assert(aliasesOf(TEST_CAPABILITIES, [], declaredWith([(["p", "r", "o", "b", "e", " ", "x"], capabilityAlias(READ, NoFixedInput))], NoDefault)).problems == []),
      assert(aliasesOf(TEST_CAPABILITIES, [], declaredWith([(["l", "i", "s", "t", " ", "x"], capabilityAlias(READ, NoFixedInput))], NoDefault)).problems ==
        [problem("reservedFirstWord", ["l", "i", "s", "t", " ", "x"], [])]),
      assert(aliasesOf(TEST_CAPABILITIES, [], declaredWith([
        (["s", " ", "x"], capabilityAlias(READ, FixedKeys([HELP]))),
        (["s"], capabilityAlias(READ, FixedKeys([HELP]))),
      ], DefaultName(["s", " ", "x"]))) == {
        problems: [],
        aliases: [
          { name: ["s"], kind: CapabilityAlias, id: READ, input: FixedKeys([HELP]) },
          { name: ["s", " ", "x"], kind: CapabilityAlias, id: READ, input: FixedKeys([HELP]) },
        ],
        default: DefaultAlias(["s", " ", "x"]),
      }),
    }
  }
}
