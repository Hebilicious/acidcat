# Agent instructions

This repository turns AcidCat into a standalone specification. Read [README.md](README.md) and [spec/divergence.md](spec/divergence.md) before doing anything else.

## Where things stand

- The repository is local only. It has no remote. Creating one, or publishing the site, is the user's decision.
- 14 of the 18 divergence rows are closed, each with a section in `spec/`. D5, D6, D11 and D18 have proposals that are waiting for the user's decision. 5 gaps remain that neither implementation covers.
- Jarette's Box (JB) is the production origin. Its accepted spec is the starting text. heb-stack (HS) holds later refinements.
- No toolchain is set up. Lean, Node and Moon are not pinned yet.

## Plan

1. **Close the inventory.** Go through the rows in order of dependency: targets and audience (D1–D3), namespace and kind (D4–D5), then manifest, versioning and errors (D6, D7, D13), then the rest. For each row:
   - Read both sources at the refs the inventory pins.
   - Propose a decision with its reasoning.
   - Ask the user about rows that change product behaviour or reverse an explicit JB decision (D5, D6, D11 and D18 do).
   - Write the decision into `spec/` and mark the row closed, linking to the section.
2. **Write the core spec and the schemas** once D1–D7 and D13 are closed.
3. **Build the Lean model** (see `lean/README.md`). Pin Lean through proto if a plugin exists; otherwise ask the user how to install it.
4. **Build the conformance kit**, then the TypeScript reference implementation. Both JB and HS must pass the kit before either one switches to the reference implementation.
5. **Build the site** last.

## Rules

- Prose is normative and uses RFC 2119 words only where a requirement is meant.
- Keep library names (Effect, XState, Vue) out of the core spec. They belong in `ref/ts/` and in implementation notes.
- One statement of each rule. Bindings and schemas refer to the core text and do not repeat it.
- Never modify `~/GitHub/jarettes-box` or `~/GitHub/heb-stack` from here. Read JB's branches with `git show <ref>:<path>`.
- Toolchains go through proto (`.prototools`) and operations through Moon tasks, as in heb-stack.
- Commits carry no AI attribution. Push only when the user asks.
