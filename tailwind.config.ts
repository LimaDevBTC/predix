import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bitcoin: '#F7931A',
        'bitcoin-dark': '#E68A00',
        up: '#22C55E',
        down: '#EF4444',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'status-in': 'statusIn 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        'jackpot-glow': 'jackpotGlow 3s ease-in-out infinite',
        'shine': 'shine 2.5s ease-in-out infinite',
      },
      keyframes: {
        statusIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        jackpotGlow: {
          '0%, 100%': { filter: 'drop-shadow(0 0 3px rgba(251, 191, 36, 0.3))' },
          '50%': { filter: 'drop-shadow(0 0 8px rgba(251, 191, 36, 0.6))' },
        },
        shine: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
      },
    },
  },
  plugins: [],
}
export default config
