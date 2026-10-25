/** A lending-library catalog, written with the TypeScript catalog library. */
import { Catalog } from "../src/index.ts";

export function libraryCatalog(): Catalog {
  const catalog = new Catalog({
    title: "Neighbourhood lending library",
    description: "Find books, lend them to members and take them back.",
  });

  catalog
    .target("members", {
      description: "The web app that members use to find and borrow books.",
      bindings: ["typescript"],
    })
    .target("desk", {
      description: "The terminal at the front desk, for librarians.",
      bindings: ["cli"],
      options: { command: "library", color: false },
    })
    .target("agents", { description: "Assistants, through an MCP server.", bindings: ["mcp"] });

  const isbn = { type: "string", pattern: "^97[89][0-9]{10}$" };
  const book = catalog.type("Book", {
    type: "object",
    required: ["isbn", "title", "authors", "available"],
    properties: {
      isbn,
      title: { type: "string" },
      authors: { type: "array", items: { type: "string" }, minItems: 1 },
      year: { type: "integer" },
      available: { type: "boolean" },
    },
  });
  const loan = catalog.type("Loan", {
    type: "object",
    required: ["id", "isbn", "member", "due"],
    properties: {
      id: { type: "string" },
      isbn,
      member: { type: "string" },
      due: { type: "string", format: "date" },
    },
  });
  const notFound = catalog.type("NotFound", {
    type: "object",
    required: ["what"],
    properties: { what: { enum: ["book", "member", "loan"] } },
  });

  return catalog
    .capability("library.books.search", {
      description: "Find books by title or author. Return at most limit books.",
      audience: ["members", "desk", "agents"],
      input: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 2 },
          availableOnly: { type: "boolean", default: false },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
      },
      output: { type: "array", items: book },
      readOnly: true,
    })
    .capability("library.loan.create", {
      description: "Lend a book to a member for three weeks.",
      audience: ["desk"],
      input: {
        type: "object",
        required: ["isbn", "member"],
        properties: { isbn, member: { type: "string" } },
      },
      output: loan,
      failures: {
        NotFound: notFound,
        OnLoan: {
          type: "object",
          description: "Another member has the book.",
          properties: { back: { type: "string", format: "date" } },
        },
      },
    })
    .capability("library.loan.return", {
      description: "Take a book back from a member.",
      audience: ["desk"],
      input: { type: "object", required: ["loan"], properties: { loan: { type: "string" } } },
      failures: {
        NotFound: notFound,
        Late: { type: "object", required: ["fee"], properties: { fee: { type: "number", minimum: 0 } } },
      },
    })
    .capability("library.loans.list", {
      description: "List the loans of the member who calls.",
      audience: ["members", "agents"],
      output: { type: "array", items: loan },
      readOnly: true,
      state: { type: "array", items: loan },
    });
}

if (import.meta.main) process.stdout.write(libraryCatalog().render());
