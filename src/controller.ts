/**
 * Glue between a loaded tour, the player, the editor presenter, the speech service and the UI.
 * Produces one snapshot that feeds the sidebar, the status bar and `.showme/status.json`.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { Presenter } from './editor/presenter';
import { Player, PlayerState } from './player/player';
import { resolveRange } from './tour/anchor';
import { StatusWriter, resolveTourRoot, statusDirFor } from './tour/files';
import { Tour, TourIssue, parseTourText } from './tour/schema';
import { AudioPlayer } from './tts/audioPlayer';
import { TtsService } from './tts/ttsService';

export type ViewState = PlayerState | 'loading';

export interface ViewSnapshot {
  state: ViewState;
  title?: string;
  tourFile?: string;
  index: number;
  total: number;
  steps: Array<{ title: string; location?: string; narration: string; issue?: string }>;
  issues: TourIssue[];
  voice: string;
}

interface StepInfo {
  issue?: string;
  shownLines?: [number, number];
}

export class Controller implements vscode.Disposable {
  readonly player: Player;

  private tour: Tour | undefined;
  private tourUri: vscode.Uri | undefined;
  private root: vscode.Uri | undefined;
  private parseIssues: TourIssue[] = [];
  private stepInfo: StepInfo[] = [];
  private loading = false;
  private loadSeq = 0;
  private lastContext: boolean | undefined;

  private readonly emitter = new vscode.EventEmitter<ViewSnapshot>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  /** Set by the extension so a starting tour can bring the sidebar into view. */
  revealUi: () => void = () => undefined;

  constructor(
    private readonly presenter: Presenter,
    private readonly tts: TtsService,
    audio: AudioPlayer,
    private readonly status: StatusWriter,
    private readonly log: (line: string) => void,
  ) {
    this.player = new Player(tts, audio, {
      present: (i) => this.present(i),
      changed: () => this.changed(),
      options: () => {
        const c = vscode.workspace.getConfiguration('showme');
        return { autoAdvance: c.get<boolean>('autoAdvance', true), pauseBetweenStepsMs: c.get<number>('pauseBetweenSteps', 600) };
      },
      error: (err, i) => this.log(`[player] step ${i + 1}: ${err instanceof Error ? err.message : String(err)}`),
    });
    this.disposables.push(tts.onDidChange(() => this.changed()));
  }

  get hasTour(): boolean {
    return !!this.tour;
  }

  async playFile(uri: vscode.Uri, startAt = 0): Promise<void> {
    const seq = ++this.loadSeq;
    this.player.stop();
    this.loading = true;
    this.tourUri = uri;
    this.tour = undefined;
    this.parseIssues = [];
    this.stepInfo = [];
    this.changed();
    this.log(`[tour] loading ${uri.fsPath}`);

    let parsed: ReturnType<typeof parseTourText>;
    try {
      parsed = parseTourText(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
    } catch (err) {
      parsed = { issues: [{ severity: 'error', message: `Could not read tour file: ${(err as Error).message}` }] };
    }
    if (seq !== this.loadSeq) return;

    this.parseIssues = parsed.issues;
    parsed.issues.forEach((i) => this.log(`[tour] ${i.severity}${i.step ? ` (step ${i.step})` : ''}: ${i.message}`));
    if (!parsed.tour) {
      this.loading = false;
      this.changed();
      void vscode.window.showErrorMessage(`ShowMe: can't play ${path.basename(uri.fsPath)}: ${parsed.issues[0]?.message ?? 'invalid tour'}`);
      return;
    }

    const tour = parsed.tour;
    this.tour = tour;
    this.root = resolveTourRoot(uri, tour);
    this.stepInfo = tour.steps.map(() => ({}));
    await this.preflight(tour);
    if (seq !== this.loadSeq) return;
    this.changed();

    this.presenter.beginTour();
    this.revealUi();
    await this.tts.prepareTour(tour.steps.map((s) => s.narration));
    if (seq !== this.loadSeq) return;

    this.loading = false;
    this.player.start(tour.steps.length, startAt);
  }

  replayTour(): void {
    if (this.tourUri) void this.playFile(this.tourUri);
  }

  goto(index: number): void {
    if (this.player.state === 'idle') {
      if (this.tourUri) void this.playFile(this.tourUri, index);
      return;
    }
    this.player.goto(index);
  }

  stop(): void {
    this.loadSeq++;
    this.loading = false;
    this.player.stop();
  }

  dispose(): void {
    this.stop();
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }

  /** Checks every step up front so the agent sees all problems in status.json right away. */
  private async preflight(tour: Tour): Promise<void> {
    await Promise.all(
      tour.steps.map(async (step, i) => {
        if (!step.file) return;
        const uri = this.stepUri(step.file);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          if (step.lines) {
            const lines = Array.from({ length: doc.lineCount }, (_, n) => doc.lineAt(n).text);
            const r = resolveRange(lines, step.lines[0], step.lines[1], step.anchor);
            this.stepInfo[i] = { shownLines: [r.start, r.end], issue: r.warning };
          }
        } catch {
          this.stepInfo[i] = { issue: `File not found: ${step.file}` };
        }
      }),
    );
  }

  private async present(index: number): Promise<void> {
    const tour = this.tour;
    if (!tour) return;
    const step = tour.steps[index];
    const result = await this.presenter.show({
      index,
      total: tour.steps.length,
      title: step.title,
      narration: step.narration,
      uri: step.file ? this.stepUri(step.file) : undefined,
      lines: step.lines,
      anchor: step.anchor,
    });
    const issue = result.missing ? `File not found: ${step.file}` : result.warning;
    this.stepInfo[index] = { shownLines: result.shownLines, issue };
    if (issue) this.log(`[tour] step ${index + 1}: ${issue}`);
    this.changed();
  }

  private stepUri(file: string): vscode.Uri {
    if (path.isAbsolute(file)) return vscode.Uri.file(file);
    return vscode.Uri.joinPath(this.root ?? vscode.Uri.file('/'), file);
  }

  private snapshot(): ViewSnapshot {
    const tour = this.tour;
    return {
      state: this.loading ? 'loading' : this.player.state,
      title: tour?.title,
      tourFile: this.tourUri ? vscode.workspace.asRelativePath(this.tourUri) : undefined,
      index: this.player.index,
      total: tour?.steps.length ?? 0,
      steps: (tour?.steps ?? []).map((s, i) => {
        const shown = this.stepInfo[i]?.shownLines ?? s.lines;
        return {
          title: s.title ?? firstWords(s.narration),
          location: s.file ? `${s.file}${shown ? `:${shown[0]}${shown[1] !== shown[0] ? `-${shown[1]}` : ''}` : ''}` : undefined,
          narration: s.narration,
          issue: this.stepInfo[i]?.issue,
        };
      }),
      issues: this.allIssues(),
      voice: this.tts.label,
    };
  }

  private allIssues(): TourIssue[] {
    const issues = [...this.parseIssues];
    this.stepInfo.forEach((info, i) => {
      if (info.issue) {
        issues.push({ step: i + 1, severity: info.issue.startsWith('File not found') ? 'error' : 'warning', message: info.issue });
      }
    });
    return issues;
  }

  private changed(): void {
    const snap = this.snapshot();
    this.emitter.fire(snap);

    const active = snap.state !== 'idle';
    if (active !== this.lastContext) {
      this.lastContext = active;
      void vscode.commands.executeCommand('setContext', 'showme.active', active);
    }
    if (this.player.state === 'idle' && !this.loading) this.presenter.clear();

    if (this.tourUri) {
      const dir = statusDirFor(this.tourUri);
      if (dir) this.status.write(dir, this.agentStatus(snap));
    }
  }

  /** What agents read from `.showme/status.json`. Keep this stable: the skill documents it. */
  private agentStatus(snap: ViewSnapshot): unknown {
    const tour = this.tour;
    const step = tour && snap.state !== 'idle' && snap.state !== 'loading' ? tour.steps[snap.index] : undefined;
    const state = snap.state === 'idle' ? (tour ? 'stopped' : this.parseIssues.length ? 'error' : 'idle') : snap.state;
    return {
      about: 'Written by the ShowMe VS Code extension. Shows what the user is looking at. Do not edit.',
      updatedAt: new Date().toISOString(),
      state,
      tour: this.tourUri
        ? { file: snap.tourFile, title: tour?.title ?? null, totalSteps: tour?.steps.length ?? 0 }
        : null,
      currentStep: step
        ? {
            number: snap.index + 1,
            title: step.title ?? null,
            file: step.file ?? null,
            lines: step.lines ?? null,
            shownLines: this.stepInfo[snap.index]?.shownLines ?? null,
            narration: step.narration,
          }
        : null,
      issues: snap.issues,
    };
  }
}

function firstWords(text: string, n = 7): string {
  const words = text.replace(/[`*_]/g, '').split(/\s+/).filter(Boolean);
  return words.slice(0, n).join(' ') + (words.length > n ? '…' : '');
}
