const tag = /<[a-z][^<>]*>/g;

/**
 * Vue keeps static HTML as one string, and VitePress leaves that string out of the script that starts the page, only
 * when each attribute is a known HTML attribute. `role` is not one, so the components of the docs write `data-role`.
 * This step adds the role to each element of a built page, so that the page has its roles before a script runs. After a
 * page change in the browser, `usePageBehaviors` gives the roles.
 */
export const writeRoles = (html: string): string => html.replace(tag, (element) => element.replace(/ data-role="([a-z]+)"/g, ' data-role="$1" role="$1"'));
