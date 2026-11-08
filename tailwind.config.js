/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./admin.html", "./appwebsite.js", "./adminwebsite.js"],
  theme: {
    extend: {
      boxShadow: {
        soft: "0 10px 35px rgba(15, 23, 42, 0.08)",
        glow: "0 10px 35px rgba(249, 115, 22, 0.22)"
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translate3d(0, 0, 0)" },
          "50%": { transform: "translate3d(0, -10px, 0)" }
        },
        pulseSoft: {
          "0%, 100%": { transform: "scale(1)", opacity: ".55" },
          "50%": { transform: "scale(1.08)", opacity: ".85" }
        }
      },
      animation: {
        float: "float 5s ease-in-out infinite",
        "pulse-soft": "pulseSoft 4s ease-in-out infinite"
      }
    }
  },
  plugins: []
}
