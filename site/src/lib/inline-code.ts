const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const inlineCode = (text: string): string => escape(text).replace(/`([^`]+)`/g, "<code>$1</code>");
