/**
 * The operating system's own text-to-speech, rendered to a file so it shares the playback path
 * with Kokoro. Used while the Kokoro model downloads, when Kokoro can't run, or when chosen.
 *
 *   macOS    `say`                                    AIFF
 *   Windows  System.Speech (SAPI), Windows PowerShell  WAV
 *   Linux    espeak-ng (or espeak)                    WAV
 */
import { spawn } from 'child_process';
import * as path from 'path';
import { findFirstOnPath } from '../util/which';

export interface SystemVoice {
  /** Short name for the sidebar, e.g. "macOS voice". */
  label: string;
  /** File extension of the clips it writes. */
  extension: 'aiff' | 'wav';
  speakToFile(text: string, outFile: string, voice: string, speed: number): Promise<void>;
}

let cached: SystemVoice | null | undefined;

/** The system voice for this platform, or undefined if there is none (e.g. Linux without espeak). */
export function systemVoice(): SystemVoice | undefined {
  if (cached === undefined) cached = detect() ?? null;
  return cached ?? undefined;
}

function detect(): SystemVoice | undefined {
  switch (process.platform) {
    case 'darwin':
      return macVoice;
    case 'win32':
      return windowsVoice;
    default: {
      const espeak = findFirstOnPath(['espeak-ng', 'espeak']);
      return espeak ? espeakVoice(espeak.file) : undefined;
    }
  }
}

const MAC_BASE_WPM = 185;

const macVoice: SystemVoice = {
  label: 'macOS voice',
  extension: 'aiff',
  speakToFile(text, outFile, voice, speed) {
    const args = ['-o', outFile, '-r', String(Math.round(MAC_BASE_WPM * speed)), '-f', '-'];
    if (voice) args.unshift('-v', voice);
    return run('say', args, { stdin: text });
  },
};

/**
 * SAPI through Windows PowerShell 5.1 (`powershell.exe`; System.Speech is missing from `pwsh`).
 * The text travels in an environment variable: no quoting, and Unicode survives, which stdin
 * would not under the console code page.
 */
const WINDOWS_SAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($env:SHOWME_VOICE) {
    try { $s.SelectVoice($env:SHOWME_VOICE) } catch { [Console]::Error.WriteLine("Voice not found: $env:SHOWME_VOICE") }
  }
  $s.Rate = [int]$env:SHOWME_RATE
  $s.SetOutputToWaveFile($env:SHOWME_OUT)
  $s.Speak($env:SHOWME_TEXT)
} finally {
  $s.Dispose()
}
`;

const windowsVoice: SystemVoice = {
  label: 'Windows voice',
  extension: 'wav',
  speakToFile(text, outFile, voice, speed) {
    return run(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(WINDOWS_SAPI_SCRIPT)], {
      env: { SHOWME_TEXT: text, SHOWME_OUT: outFile, SHOWME_VOICE: voice, SHOWME_RATE: String(sapiRate(speed)) },
    });
  },
};

const ESPEAK_BASE_WPM = 175;

function espeakVoice(bin: string): SystemVoice {
  return {
    label: 'eSpeak voice',
    extension: 'wav',
    speakToFile(text, outFile, voice, speed) {
      const args = ['-b', '1', '-w', outFile, '-s', String(Math.round(ESPEAK_BASE_WPM * speed)), '--stdin'];
      if (voice) args.unshift('-v', voice);
      return run(bin, args, { stdin: text });
    },
  };
}

/** SAPI rate is -10..10, where ±10 is about 3× faster or slower than normal. */
export function sapiRate(speed: number): number {
  const rate = Math.round((10 * Math.log(speed)) / Math.log(3));
  return Math.max(-10, Math.min(10, rate));
}

/** `-EncodedCommand` takes base64 of UTF-16LE. It also sidesteps execution policy and quoting. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Windows PowerShell 5.1, by full path so a `powershell.exe` earlier on PATH can't stand in for it. */
export function windowsPowerShell(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function run(cmd: string, args: string[], opts: { stdin?: string; env?: Record<string, string> }): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
    });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with ${code}: ${stderr.trim()}`)),
    );
    p.stdin.on('error', () => undefined); // the process may exit before reading stdin
    p.stdin.end(opts.stdin ?? '');
  });
}
