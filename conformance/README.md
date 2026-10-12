# Conformance kit

Checks that any implementation can run, whatever its language. [Conformance](../spec/conformance.md) states what they cover:

- the catalog validates against `schemas/` and follows the rules the schema cannot express;
- through each binding, a target serves exactly its view, and refuses every other id as unknown;
- invalid input never starts the work, and every outcome arrives in the form its binding defines;
- the Lean-generated vectors replay with the outcomes the model predicts, against a fixture catalog that the kit supplies.

Jarette's Box and heb-stack are the first two implementations it must pass.
