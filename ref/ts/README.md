# TypeScript reference implementation

The kernel and the generic adapters (TypeScript handles, WebMCP, MCP, CLI, HTTP, GraphQL), built on Effect and XState. Both applications consume it instead of keeping their own copy.

Domain-specific helpers do not belong here. It also generates and checks catalogs from Effect definitions, which is how Jarette's Box and heb-stack adopt the spec (see `spec/adoption.md`). The kernel starts from the two existing kernels.
