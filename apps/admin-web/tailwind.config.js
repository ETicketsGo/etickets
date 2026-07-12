const preset = require('@eticketsgo/design-tokens/tailwind-preset').default;

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [preset],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../../packages/web-kit/src/**/*.{ts,tsx}',
  ],
};
