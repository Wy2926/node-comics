import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({
  cacheDir:'node_modules/.vite-account-fixture',
  resolve:{alias:[{find:'../lib/auth',replacement:fileURLToPath(new URL('./account-fixture-auth.ts',import.meta.url))}]},
  server:{host:'127.0.0.1',port:5193,strictPort:true},
});
