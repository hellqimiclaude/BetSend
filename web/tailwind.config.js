/**
 * BetLive's house style.
 *
 * The colours are sampled from betlive.com rather than guessed: the green is
 * the one on its Sign In button, the red is its NEW badge, and the three dark
 * surfaces are its page background, header bar and input fields.
 *
 * @type {import('tailwindcss').Config}
 */

/**
 * BetLive's vivid red, and the app's primary action colour.
 *
 * On betlive.com the red is the accent and the green is the button, but
 * BetSend takes them the other way round -- red leads, green supports.
 * 500 is the sampled value; the ramp is built around it, with 600 as the
 * resting state for filled buttons so hover has somewhere brighter to go.
 */
const brand = {
  50: '#ffe9ed',
  100: '#ffccd5',
  200: '#ff99a9',
  300: '#fb5f78',
  400: '#f82a4d',
  500: '#f50628', // sampled: the NEW badge and carousel bar
  600: '#d60421',
  700: '#b0031b',
  800: '#870316',
  900: '#630311',
  950: '#3a0109',
};

/**
 * BetLive's deep green, here the supporting colour: confirmation, healthy
 * states, and the unread count. Kept rare so it still registers.
 */
const accent = {
  50: '#e9f7ee',
  100: '#c8ebd4',
  200: '#93dcae',
  300: '#5bc886',
  400: '#1fad59',
  500: '#0d9b45',
  600: '#058c35', // sampled: the Sign In button
  700: '#04752c',
  800: '#055d25',
  900: '#064c20',
  950: '#02230f',
};

/**
 * Tailwind's `slate` is replaced rather than supplemented.
 *
 * Every surface and every piece of muted text in this app already reaches for
 * slate, so redefining it here re-skins the whole thing at once -- the
 * alternative was renaming the colour in two hundred places and burying the
 * actual change in the diff.
 *
 * 950, 900 and 800 are sampled straight off betlive.com: its page background,
 * its header bar and its input fields. They are violet-tinted near-blacks,
 * not the blue-grey Tailwind ships, which is why the stock palette looked
 * wrong next to the brand. The light end is a neutral ramp built to match.
 */
const slate = {
  50: '#f7f7f9',
  100: '#eeeef2',
  200: '#dddde4',
  300: '#c3c3cd',
  400: '#9d9da9',
  500: '#74747f',
  600: '#53535e',
  700: '#2e2e38',
  800: '#202128', // sampled: input fields
  900: '#18171f', // sampled: header and nav bar
  950: '#101118', // sampled: page background
};

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { brand, accent, slate },
      fontFamily: {
        // Self-hosted, so this works on a network with no way out. The
        // Georgian face is in the stack because the people using BetSend work
        // in Tbilisi; neither Inter nor Montserrat covers the alphabet.
        sans: [
          'Inter',
          'Noto Sans Georgian',
          'Segoe UI',
          'system-ui',
          '-apple-system',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        // Headings and the wordmark. Montserrat's heavy geometric letterforms
        // are the closest widely available match to the betlive logotype.
        display: [
          'Montserrat',
          'Noto Sans Georgian',
          'Segoe UI',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
      },
      keyframes: {
        'slide-in': {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'slide-in': 'slide-in 180ms ease-out',
      },
    },
  },
  plugins: [],
};
