import { onUnmounted } from "vue";

type Listener = () => void;

const listeners = new Set<Listener>();

/** Runs a function each time the content of a page is in the DOM: after hydration, and after each page change. */
export const onPageUpdated = (listener: Listener): void => {
  listeners.add(listener);
  onUnmounted(() => listeners.delete(listener));
};

export const pageUpdated = (): void => {
  for (const listener of listeners) listener();
};
