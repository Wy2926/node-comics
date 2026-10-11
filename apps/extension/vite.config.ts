import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {importAssets} from './import-assets';
import {unrarCsp} from './unrar-csp';
import {writeStoreLocales} from './store-locales';
import {pdfjsCsp} from './pdfjs-csp';
writeStoreLocales();
export default defineConfig({ plugins: [react(),importAssets(),unrarCsp(),pdfjsCsp()], optimizeDeps:{exclude:['node-unrar-js','pdfjs-dist'],include:['@zip.js/zip.js/index-native.js']}, worker:{format:'es',plugins:()=>[unrarCsp()]}, build: { outDir: 'dist-web' } });
