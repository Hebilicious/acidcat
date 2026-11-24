/** The wide key art, in pixels: its size, and the width of the extension at its left for the headline. */
export const art = { width: 2400, height: 941, pad: 728 } as const;

/**
 * The columns of the key art that the phone plates keep. At 960px and below, the hero has a fixed aspect ratio, so
 * it always shows the same region: these columns hold it, with a margin for the parallax.
 */
export const phoneCrop = { x: 1130, width: 1052 } as const;

export const phoneMedia = "(max-width: 960px)";
