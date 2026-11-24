import { defineConfig } from "@hebilicious/cssforge";

export default defineConfig({
  typography: {
    fluid: {
      text: {
        value: {
          minWidth: 360,
          minFontSize: 16,
          minTypeScale: 1.125,
          maxWidth: 1440,
          maxFontSize: 17,
          maxTypeScale: 1.2,
          positiveSteps: 3,
          negativeSteps: 2,
        },
      },
      display: {
        value: {
          minWidth: 360,
          minFontSize: 20,
          minTypeScale: 1.2,
          maxWidth: 1440,
          maxFontSize: 22,
          maxTypeScale: 1.4,
          positiveSteps: 5,
          negativeSteps: 1,
        },
      },
    },
    weight: {
      display: { value: { regular: "450", medium: "500", bold: "600" } },
    },
  },
  spacing: {
    fluid: {
      space: {
        value: {
          minSize: 14,
          maxSize: 18,
          minWidth: 360,
          maxWidth: 1440,
          negativeSteps: [0.25, 0.5, 0.75],
          positiveSteps: [1.5, 2, 3, 4, 6, 8],
        },
      },
    },
  },
  primitives: {
    font: {
      value: {
        family: {
          value: {
            display: '"Monaspace Xenon", ui-monospace, "SFMono-Regular", Menlo, monospace',
            accent: '"Monaspace Radon", "Monaspace Xenon", ui-monospace, monospace',
            sans: '"Monaspace Argon", ui-monospace, "SFMono-Regular", Menlo, monospace',
            label: '"Monaspace Krypton", ui-monospace, "SFMono-Regular", Menlo, monospace',
            mono: '"Monaspace Neon", ui-monospace, "SFMono-Regular", Menlo, monospace',
          },
        },
        tracking: {
          value: { tight: "-0.02em", normal: "0", label: "0.24em", wide: "0.3em" },
        },
      },
    },
    radius: {
      value: {
        size: { value: { s: "6px", m: "10px", l: "18px", xl: "22px" } },
      },
    },
    layout: {
      value: {
        width: { value: { content: "1240px", wide: "1320px" } },
        gutter: { value: { inline: "clamp(1rem, 4vw, 2.5rem)" } },
      },
    },
  },
  colors: {
    palette: {
      value: {
        ink: {
          value: {
            950: { hex: "#05070b" },
            925: { hex: "#07090d" },
            900: { hex: "#0b0e14" },
            800: { hex: "#121722" },
            700: { hex: "#1b2230" },
            600: { hex: "#2a3344" },
          },
        },
        blueprint: {
          value: {
            800: { hex: "#172131" },
            900: { hex: "#0f1d2a" },
          },
        },
        brass: {
          value: {
            100: { hex: "#f4e7bd" },
            200: { hex: "#f6e2a4" },
            300: { hex: "#ecc965" },
            400: { hex: "#c9a227" },
            500: { hex: "#a7801a" },
            600: { hex: "#8a6b14" },
            650: { hex: "#7a5a10" },
            700: { hex: "#5e4609" },
            800: { hex: "#4a380a" },
            900: { hex: "#3d2c05" },
            950: { hex: "#2a2408" },
          },
        },
        copper: {
          value: {
            300: { hex: "#e0a274" },
            400: { hex: "#b87333" },
            700: { hex: "#6b3a16" },
          },
        },
        acid: {
          value: {
            200: { hex: "#e2ff9e" },
            400: { hex: "#b6ff3b" },
            600: { hex: "#7fc419" },
            700: { hex: "#5d9a10" },
          },
        },
        cyan: {
          value: {
            400: { hex: "#3be8ff" },
          },
        },
        nixie: {
          value: {
            200: { hex: "#ffd1a8" },
            400: { hex: "#ff8a3d" },
          },
        },
        cream: {
          value: {
            100: { hex: "#f2e6c9" },
            400: { hex: "#b9b09a" },
          },
        },
        neutral: {
          value: {
            white: { hex: "#ffffff" },
            black: { hex: "#000000" },
          },
        },
      },
    },
  },
});
