import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Library (React, Firebase) dipisah ke file sendiri supaya HP cukup mengunduh ulang
// file app saja setiap ada update — file library tetap tersimpan di cache browser.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase'
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler') || id.includes('node_modules/framer-motion') || id.includes('node_modules/motion')) return 'vendor'
        },
      },
    },
  },
})
