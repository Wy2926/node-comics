import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {importAssets} from './import-assets';
import {unrarCsp} from './unrar-csp';
import {writeStoreLocales} from './store-locales';
writeStoreLocales();
export default defineConfig({ plugins: [react(),importAssets(),unrarCsp()], optimizeDeps:{exclude:['node-unrar-js'],include:['pdfjs-dist/legacy/build/pdf.mjs','@zip.js/zip.js/index-native.js']}, worker:{format:'es',plugins:()=>[unrarCsp()]}, build: { outDir: 'dist-web' } });
