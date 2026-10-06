import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({base:process.env.VITE_BASE_PATH||'/',plugins:[react()],root:'app',server:{host:'127.0.0.1',port:process.env.VITE_NETWORK==='devnet'?5181:5180,strictPort:true,proxy:{'/api':process.env.VITE_NETWORK==='devnet'?'http://127.0.0.1:19190':'http://127.0.0.1:19189'}},build:{outDir:'../dist',emptyOutDir:true}});
