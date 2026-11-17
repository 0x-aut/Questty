/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const API_ROUTES = new Set(['quests', 'transcribe', 'buddy', 'live', 'speak']);
const MAX_DEV_BODY_BYTES = 5_000_000;

/**
 * Dev only: serve the Vercel-style functions in api/ from the Vite server so
 * voice and quest generation work locally. OPENAI_API_KEY comes from .env
 * (never a VITE_ variable, so it is never bundled into client code).
 * Production uses the platform's own function runtime (e.g. Vercel).
 */
function localApiRoutes(): Plugin {
  return {
    name: 'questty-local-api',
    apply: 'serve',
    configResolved(config) {
      const env = loadEnv(config.mode, config.root, '');
      if (!process.env.OPENAI_API_KEY && env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
      }
    },
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const match = /^\/api\/([a-z-]+)\/?(?:\?.*)?$/u.exec(req.url ?? '');
        if (!match || !API_ROUTES.has(match[1])) {
          next();
          return;
        }
        try {
          const body = await readJsonBody(req);
          const module = (await server.ssrLoadModule(`/api/${match[1]}.ts`)) as {
            default: (request: unknown, response: unknown) => Promise<void>;
          };
          let statusCode = 200;
          const response = {
            status(code: number) {
              statusCode = code;
              return response;
            },
            json(payload: unknown) {
              res.statusCode = statusCode;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(payload));
            },
          };
          await module.default({ method: req.method, body }, response);
        } catch (error) {
          server.config.logger.error(`[api] ${String(error)}`);
          if (!res.headersSent) {
            res.statusCode = error instanceof RangeError ? 413 : 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'local-api-failed' }));
          }
        }
      });
    },
  };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DEV_BODY_BYTES) {
        reject(new RangeError('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', reject);
  });
}

export default defineConfig({
  plugins: [iwsdkDev(), localApiRoutes()],
  server: { host: '0.0.0.0', port: 8081, open: false },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'esnext',
    rollupOptions: { input: './index.html' },
  },
  esbuild: { target: 'esnext' },
  // @drawcall/uikitml otherwise pulls a second three/@pmndrs/uikit graph
  // (its own three vs the app's super-three alias). Duplicate Component classes break
  // instanceof checks → "Only pmndrs/uikit components can be added as children".
  resolve: {
    dedupe: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
    ],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    include: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
      '@drawcall/uikitml',
    ],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  base: './',
});
