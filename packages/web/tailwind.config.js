/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // 品牌：克制的靛蓝。只用于主操作、选中态与品牌点缀，不做大面积铺色。
        brand: {
          DEFAULT: "#4B5AD3",
          soft: "#E4E7F8",
          50: "#F0F2FC",
          100: "#E4E7F8",
          500: "#4B5AD3",
          600: "#3E4AB8",
          700: "#333D97",
        },
        // 表面：同一冷灰色相（~225°），从页面底到卡片逐级抬升。
        surface: {
          DEFAULT: "#FFFFFF",
          card: "#F8F9FB",
          muted: "#F4F6F9",
          sunken: "#ECEFF5",
          invert: "#4B5AD3",
        },
        text: {
          primary: "#181B25",
          secondary: "#4E5567",
          muted: "#8B93A7",
        },
        // Asset 类型色标：低饱和、同明度，保证并排不打架。
        "skill-blue": { bg: "#E4E7F8", text: "#4B5AD3" },
        "rule-yellow": { bg: "#FBF3DC", text: "#9A7412" },
        "mcp-green": { bg: "#DFF3E8", text: "#17795A" },
        "hook-purple": { bg: "#EEEAFB", text: "#6D4FC2" },
        "command-cyan": { bg: "#DFF3F6", text: "#0E7D8C" },
        "agent-coral": { bg: "#FBE9F0", text: "#C2437C" },
      },
      fontFamily: {
        sans: ['"Outfit"', '"Noto Sans SC"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      borderRadius: {
        lg: "10px",
        xl: "14px",
        "2xl": "18px",
        "3xl": "24px",
      },
      boxShadow: {
        // 阴影统一带蓝灰色调（hue ~230），不用纯黑。
        soft: "0 1px 2px rgba(24, 32, 68, 0.04), 0 1px 3px rgba(24, 32, 68, 0.05)",
        card: "0 1px 3px rgba(24, 32, 68, 0.05)",
        lift: "0 12px 28px -8px rgba(24, 32, 68, 0.13), 0 3px 8px rgba(24, 32, 68, 0.05)",
        panel: "0 24px 64px -16px rgba(24, 32, 68, 0.24)",
        brand: "0 6px 20px -6px rgba(75, 90, 211, 0.4)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.97)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "card-in": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.25s ease-out",
        "fade-up": "fade-up 0.3s cubic-bezier(0.32,0.72,0,1)",
        "scale-in": "scale-in 0.2s cubic-bezier(0.32,0.72,0,1)",
        "card-in": "card-in 0.4s cubic-bezier(0.22,1,0.36,1) both",
      },
    },
  },
  plugins: [],
};
