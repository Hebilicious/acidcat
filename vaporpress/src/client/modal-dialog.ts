import { onBeforeUnmount, onMounted, watch } from "vue";
import type { Ref } from "vue";
import { openModal } from "../behaviors/modal.ts";

export interface ModalDialog {
  readonly open: () => boolean;
  readonly shown: (typing: boolean) => void;
  readonly openBeforeMount: () => void;
}

export const useModalDialog = (dialog: Readonly<Ref<HTMLDialogElement | null>>, { open, shown, openBeforeMount }: ModalDialog): void => {
  let close: (() => void) | undefined;
  const hide = (): void => {
    close?.();
    close = undefined;
  };
  watch(open, (isOpen) => {
    const element = dialog.value;
    if (!isOpen) hide();
    else if (element !== null) {
      const typing = element.open;
      close = openModal(element);
      shown(typing);
    }
  });
  onMounted(() => {
    if (dialog.value?.open === true) openBeforeMount();
  });
  onBeforeUnmount(hide);
};

// v-model writes the value of its ref into the field when the component hydrates, so the ref starts with the text that the reader typed before.
export const fieldValueBeforeHydration = (selector: string): string | undefined =>
  import.meta.env.SSR ? undefined : (document.querySelector<HTMLInputElement>(selector)?.value ?? undefined);
