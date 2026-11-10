import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        mist: "#F6F8FB",
        surface: "#FFFFFF",
        ink: "#1B2430",
        inkfaint: "#5B6B78",
        hairline: "#E4E8EF",
        teal: {
          DEFAULT: "#3D7BEA",
          soft: "#EAF2FE",
        },
        sky: {
          DEFAULT: "#64728A",
          soft: "#EEF1F5",
        },
        mustard: {
          DEFAULT: "#C08A1E",
          soft: "#FDF3DE",
        },
        terracotta: {
          DEFAULT: "#D14343",
          soft: "#FCEAE8",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(27,36,48,0.04), 0 8px 24px -12px rgba(27,36,48,0.10)",
      },
    },
  },
  plugins: [],
};
export default config;
