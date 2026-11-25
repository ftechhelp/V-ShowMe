/**
 * Child process that runs Kokoro-82M (ONNX, CPU). Forked by kokoro.ts so model loading and
 * inference never block the VS Code extension host.
 *
 * kokoro-js is intentionally NOT bundled: it loads its voice files relative to its own dist folder.
 */
import { rename } from 'fs/promises';

export type WorkerRequest =
  | { type: 'init'; cacheDir: string; dtype: 'fp32' | 'q8' }
  | { type: 'synth'; id: number; text: string; voice: string; speed: number; outFile: string };

export type WorkerMessage =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'ready'; loadMs: number }
  | { type: 'initFailed'; message: string }
  | { type: 'done'; id: number; ms: number }
  | { type: 'failed'; id: number; message: string };

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts: any;
let chain: Promise<void> = Promise.resolve();

function send(msg: WorkerMessage): void {
  process.send?.(msg);
}

async function init(cacheDir: string, dtype: 'fp32' | 'q8'): Promise<void> {
  const started = Date.now();
  const transformers = require('@huggingface/transformers');
  transformers.env.cacheDir = cacheDir;
  const { KokoroTTS } = require('kokoro-js');
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device: 'cpu',
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file && p.total) {
        send({ type: 'progress', file: p.file, loaded: p.loaded ?? 0, total: p.total });
      }
    },
  });
  send({ type: 'ready', loadMs: Date.now() - started });
}

async function synth(req: Extract<WorkerRequest, { type: 'synth' }>): Promise<void> {
  const started = Date.now();
  const audio = await tts.generate(req.text, { voice: req.voice, speed: req.speed });
  const tmp = `${req.outFile}.${process.pid}.tmp.wav`;
  await audio.save(tmp);
  await rename(tmp, req.outFile);
  send({ type: 'done', id: req.id, ms: Date.now() - started });
}

process.on('message', (msg: WorkerRequest) => {
  if (msg.type === 'init') {
    chain = chain.then(() =>
      init(msg.cacheDir, msg.dtype).catch((err) => send({ type: 'initFailed', message: String(err?.stack ?? err) })),
    );
  } else if (msg.type === 'synth') {
    chain = chain.then(() =>
      synth(msg).catch((err) => send({ type: 'failed', id: msg.id, message: String(err?.message ?? err) })),
    );
  }
});

process.on('disconnect', () => process.exit(0));
