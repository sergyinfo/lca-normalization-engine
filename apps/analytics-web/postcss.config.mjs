/**
 * PostCSS config for Tailwind 4. The new architecture is CSS-first:
 * tailwindcss config lives inside globals.css via @import "tailwindcss"
 * and @theme blocks. PostCSS only needs to pipe through @tailwindcss/postcss.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
