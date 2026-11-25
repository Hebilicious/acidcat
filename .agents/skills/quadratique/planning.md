# From a plan or a PRD to issues

One issue per change that can be reviewed and merged on its own, written for an implementer who never saw the conversation: `quadratique create --title "<the outcome>" --description "<what, why, the plan's path>" --acceptance "<checkable criteria, one per line, with the command that proves each>" --priority <1 urgent to 4 low>`.

Order them with `quadratique issue link --issue A --kind blocks --target B` when B starts only after A is done. A decision only the human can make is its own issue (`--assignee '{"kind":"human"}'`) that blocks what depends on it. Done when every part of the plan has an issue, `quadratique ready` lists exactly what can start now, and the human has the ids.
