export const installOncePerDocument = (attribute: string, install: () => void): void => {
  const root = document.documentElement;
  if (root.hasAttribute(attribute)) return;
  root.setAttribute(attribute, "");
  install();
};
