/**
 * The context of the web handlers: one context that all requests share, or a new context for each request.
 */

export type ContextOption<Context> =
  | {
      /** The context of all requests. */
      readonly context: Context;
      readonly createContext?: undefined;
    }
  | {
      /**
       * Make the context of one request. The handler calls it for each request that passes the screening. When the
       * context has `Symbol.asyncDispose` or `Symbol.dispose`, the handler calls it after the response, as a `using`
       * declaration does.
       */
      readonly createContext: (request: Request) => Context | Promise<Context>;
      readonly context?: undefined;
    };

/** Give the context of one request to `use`, and release it afterwards if the handler made it. */
export async function withContext<Context, A>(
  option: ContextOption<Context>,
  request: Request,
  use: (context: Context) => Promise<A>,
): Promise<A> {
  if (option.createContext === undefined) return use(option.context);
  const context = await option.createContext(request);
  try {
    return await use(context);
  } finally {
    await release(context);
  }
}

/** Call `Symbol.asyncDispose` or `Symbol.dispose` of a value, if it has one. */
async function release(value: unknown): Promise<void> {
  if (typeof value !== "object" || value === null) return;
  const disposable = value as Partial<AsyncDisposable & Disposable>;
  if (typeof disposable[Symbol.asyncDispose] === "function") await disposable[Symbol.asyncDispose]!();
  else if (typeof disposable[Symbol.dispose] === "function") disposable[Symbol.dispose]!();
}
