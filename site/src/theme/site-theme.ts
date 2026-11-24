import type { DefaultTheme } from "vitepress";

export interface SidebarLink {
  readonly text: string;
  readonly link: string;
}

export interface SidebarGroup {
  readonly text: string;
  readonly items: readonly SidebarLink[];
}

export type SidebarItem = SidebarLink | SidebarGroup;

export interface Section {
  readonly prefix: string;
  readonly title: string;
  readonly note: string;
  readonly href: string;
  readonly items: readonly SidebarItem[];
}

export interface SiteTheme {
  readonly editBase: string;
  readonly sections: readonly Section[];
  readonly search: DefaultTheme.Config["search"];
}

export const isGroup = (item: SidebarItem): item is SidebarGroup => "items" in item;

export const flatLinks = (items: readonly SidebarItem[]): SidebarLink[] => items.flatMap((item) => (isGroup(item) ? item.items : [item]));
