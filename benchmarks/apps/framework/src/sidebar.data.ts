import { defineLoader } from "framework/data";
import type { LoadedData } from "framework/data";
import { readFixture, sidebar } from "../../../src/fixture.ts";

const loader = defineLoader({
  load: async () => {
    const pages = await readFixture();
    const titleOf = (id: string): string => pages.find((page) => page.id === id)?.title ?? id;
    return sidebar.map((group) => ({ label: group.label, links: group.items.map((id) => ({ text: titleOf(id), href: `/${id.replace(/index$/, "")}/`.replace("//", "/") })) }));
  },
});

export default loader;
export declare const data: LoadedData<typeof loader>;
