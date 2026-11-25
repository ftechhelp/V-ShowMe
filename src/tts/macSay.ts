/** Built-in macOS speech via `say`, rendered to a file so it shares the playback path with Kokoro. */
import { spawn } from 'child_process';

export const SAY_AVAILABLE = process.platform === 'darwin';
const BASE_WPM = 185;

export function sayToFile(text: string, outFile: string, voice: string, speed: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-o', outFile, '-r', String(Math.round(BASE_WPM * speed)), '-f', '-'];
    if (voice) args.unshift('-v', voice);
    const p = spawn('say', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`say exited with ${code}: ${stderr.trim()}`))));
    p.stdin.end(text);
  });
}
