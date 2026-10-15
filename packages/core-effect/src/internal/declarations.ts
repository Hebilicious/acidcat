/** The declaration of each capability that a lazy capability loaded, so that caches keep one entry for both. */
export const declarations = new WeakMap<object, object>();

/** The declaration of a capability: the lazy capability for one that it loaded, else the capability itself. */
export const declarationOf = <T extends object>(capability: T): object => declarations.get(capability) ?? capability;
