/**
 * Long-lived audio helper for Windows: one Windows PowerShell process that compiles a small C#
 * class (no extra download) and plays WAV clips through winmm's MCI, which can pause and resume.
 * Starting it once avoids PowerShell's startup delay before every sentence.
 *
 * Protocol, one line each way:
 *   stdin   play <id> <path> | pause | resume | stop | quit
 *   stdout  ready | ended <id> | error <id or -> <message>
 */
import { ChildProcess, spawn } from 'child_process';
import * as readline from 'readline';
import { encodePowerShell, windowsPowerShell } from './systemVoice';

export interface WinHostEvents {
  ended(id: number): void;
  error(id: number | undefined, message: string): void;
  exit(code: number | null): void;
}

export interface WinHostLike {
  play(id: number, file: string): void;
  pause(): void;
  resume(): void;
  stop(): void;
  dispose(): void;
}

export class WinAudioHost implements WinHostLike {
  private disposed = false;

  private constructor(
    private readonly proc: ChildProcess,
    events: WinHostEvents,
    log: (line: string) => void,
  ) {
    readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
      const event = parseHostLine(line);
      if (!event) return;
      if (event.type === 'ready') log('[audio] Windows audio helper ready');
      else if (event.type === 'ended') events.ended(event.id);
      else events.error(event.id, event.message);
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d));
    proc.on('exit', (code) => {
      if (this.disposed) return;
      if (stderr.trim()) log(`[audio] helper stderr: ${stderr.trim().slice(0, 2000)}`);
      events.exit(code);
    });
    proc.on('error', (err) => {
      if (this.disposed) return;
      log(`[audio] helper failed to start: ${err.message}`);
      events.exit(null);
    });
    proc.stdin?.on('error', () => undefined);
  }

  static start(events: WinHostEvents, log: (line: string) => void): WinAudioHost | undefined {
    try {
      const proc = spawn(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(HOST_SCRIPT)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return new WinAudioHost(proc, events, log);
    } catch (err) {
      log(`[audio] could not start the Windows audio helper: ${(err as Error).message}`);
      return undefined;
    }
  }

  play(id: number, file: string): void {
    this.send(`play ${id} ${file}`);
  }
  pause(): void {
    this.send('pause');
  }
  resume(): void {
    this.send('resume');
  }
  stop(): void {
    this.send('stop');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.send('quit');
    this.proc.stdin?.end();
    setTimeout(() => this.proc.kill(), 1000).unref?.();
  }

  private send(line: string): void {
    if (this.proc.stdin?.writable) this.proc.stdin.write(line + '\n');
  }
}

export type HostEvent =
  | { type: 'ready' }
  | { type: 'ended'; id: number }
  | { type: 'error'; id: number | undefined; message: string };

export function parseHostLine(line: string): HostEvent | undefined {
  const m = /^(ready|ended|error)(?: (\S+))?(?: (.*))?$/.exec(line.trim());
  if (!m) return undefined;
  if (m[1] === 'ready') return { type: 'ready' };
  const id = m[2] && m[2] !== '-' ? Number(m[2]) : undefined;
  if (m[1] === 'ended') return id !== undefined && Number.isFinite(id) ? { type: 'ended', id } : undefined;
  return { type: 'error', id: id !== undefined && Number.isFinite(id) ? id : undefined, message: m[3] ?? '' };
}

/**
 * Windows PowerShell 5.1 compiles this with the .NET Framework C# 5 compiler, so: no string
 * interpolation, no `?.`, no expression-bodied members. stdin is read as UTF-8 by hand because
 * Console.In uses the OEM code page, which would mangle non-ASCII paths.
 */
const HOST_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ShowMeAudioHost {
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
  static extern int mciSendStringW(string command, StringBuilder ret, int retLen, IntPtr callback);
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
  static extern bool mciGetErrorStringW(int error, StringBuilder text, int len);

  static readonly Queue<string> lines = new Queue<string>();
  static readonly object gate = new object();
  static bool eof;
  static TextWriter output;

  static string Mci(string command) {
    StringBuilder ret = new StringBuilder(256);
    int err = mciSendStringW(command, ret, ret.Capacity, IntPtr.Zero);
    if (err != 0) {
      StringBuilder text = new StringBuilder(256);
      mciGetErrorStringW(err, text, text.Capacity);
      throw new Exception("MCI " + err + ": " + text.ToString());
    }
    return ret.ToString();
  }

  static void Emit(string line) {
    output.WriteLine(line.Replace('\r', ' ').Replace('\n', ' '));
    output.Flush();
  }

  static void Close(ref string current) {
    if (current == null) return;
    current = null;
    try { Mci("close showme"); } catch (Exception) { }
  }

  static void ReadInput() {
    StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = reader.ReadLine()) != null) {
      lock (gate) { lines.Enqueue(line); Monitor.Pulse(gate); }
    }
    lock (gate) { eof = true; Monitor.Pulse(gate); }
  }

  public static void Run() {
    output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    Thread reader = new Thread(ReadInput);
    reader.IsBackground = true;
    reader.Start();
    string current = null;
    Emit("ready");
    while (true) {
      string line = null;
      bool quit = false;
      lock (gate) {
        if (lines.Count == 0 && !eof) Monitor.Wait(gate, 50);
        if (lines.Count > 0) line = lines.Dequeue();
        else if (eof) quit = true;
      }
      if (quit) break;
      if (line != null) {
        int space = line.IndexOf(' ');
        string cmd = space < 0 ? line : line.Substring(0, space);
        string rest = space < 0 ? "" : line.Substring(space + 1);
        if (cmd == "quit") break;
        try {
          if (cmd == "play") {
            Close(ref current);
            int split = rest.IndexOf(' ');
            current = rest.Substring(0, split);
            Mci("open \"" + rest.Substring(split + 1) + "\" type waveaudio alias showme");
            Mci("play showme");
          } else if (cmd == "pause") {
            if (current != null) Mci("pause showme");
          } else if (cmd == "resume") {
            if (current != null) Mci("resume showme");
          } else if (cmd == "stop") {
            Close(ref current);
          }
        } catch (Exception ex) {
          string id = current == null ? "-" : current;
          Close(ref current);
          Emit("error " + id + " " + ex.Message);
        }
        continue;
      }
      if (current != null) {
        try {
          if (Mci("status showme mode") == "stopped") {
            string id = current;
            Close(ref current);
            Emit("ended " + id);
          }
        } catch (Exception ex) {
          string id = current;
          Close(ref current);
          Emit("error " + id + " " + ex.Message);
        }
      }
    }
    Close(ref current);
  }
}
`;

const HOST_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${HOST_CSHARP}
'@
[ShowMeAudioHost]::Run()
`;

/** Exposed for the CI smoke test, which runs the helper on a Windows runner. */
export const WIN_AUDIO_HOST_SCRIPT = HOST_SCRIPT;
