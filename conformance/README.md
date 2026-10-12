# Conformance kit

Black-box checks any implementation can run against its own manifest and wire endpoints, whatever its language:

- the manifest validates against `schemas/`, ids are unique, and every id begins with its namespace;
- a target lists exactly the available leaves whose audience names it, and refuses a direct call to any other;
- undecodable input, cancellation and defects fail the invocation, while expected failures answer an error `Result`;
- the Lean-generated vectors replay with the results the model predicts.

Jarette's Box and heb-stack are the first two implementations it must pass.
