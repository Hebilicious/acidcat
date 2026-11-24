import phone840 from "../assets/hero/phone-840.avif?url";
import phone from "../assets/hero/phone.avif?url";
import phone2x from "../assets/hero/phone@2x.avif?url";
import plateAvif from "../assets/hero/plate.avif?url";
import plate2xAvif from "../assets/hero/plate@2x.avif?url";
import plateWebp from "../assets/hero/plate.webp?url";
import plate2xWebp from "../assets/hero/plate@2x.webp?url";
import { art, phoneCrop, phoneMedia } from "./plate-crop.ts";

const phoneWidth = (scale: number) => Math.round(phoneCrop.width * scale);

export const plateImages = {
  phone: {
    media: phoneMedia,
    srcset: `${phone840} 840w, ${phone} ${phoneWidth(1)}w, ${phone2x} ${phoneWidth(2)}w`,
    // At 960px and below the hero is 1.02 times as tall as it is wide, and the plate covers it by its height.
    sizes: `${Math.ceil(102 * (phoneCrop.width / art.height))}vw`,
  },
  wide: { media: `not all and ${phoneMedia}`, srcset: `${plateAvif} 1672w, ${plate2xAvif} 3344w`, sizes: "100vw" },
  fallback: { src: plateWebp, srcset: `${plateWebp} 1672w, ${plate2xWebp} 3344w`, sizes: "100vw" },
} as const;

export const preloadPlate = (): void => {
  for (const image of [plateImages.phone, plateImages.wide]) {
    if (document.head.querySelector(`link[rel="preload"][imagesrcset="${image.srcset}"]`) !== null) continue;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.type = "image/avif";
    link.media = image.media;
    link.imageSrcset = image.srcset;
    link.imageSizes = image.sizes;
    document.head.append(link);
  }
};
