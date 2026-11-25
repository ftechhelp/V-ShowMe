import * as vscode from 'vscode';
import { installSkill, pickTour } from './commands';
import { Controller } from './controller';
import { Presenter } from './editor/presenter';
import { StatusWriter, TourWatcher, listTours } from './tour/files';
import { AudioPlayer } from './tts/audioPlayer';
import { TtsService } from './tts/ttsService';
import { SidebarMessage, SidebarProvider } from './ui/sidebar';
import { StatusBar } from './ui/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('ShowMe');
  const log = (line: string) => output.appendLine(`${new Date().toISOString().slice(11, 23)} ${line}`);

  const presenter = new Presenter(vscode.Uri.joinPath(context.extensionUri, 'media', 'avatar.svg'));
  const tts = new TtsService(context, log, () => output.show(true));
  const audio = new AudioPlayer();
  const controller = new Controller(presenter, tts, audio, new StatusWriter(log), log);
  const statusBar = new StatusBar();

  const sidebar = new SidebarProvider(context.extensionUri, (msg: SidebarMessage) => {
    if (msg.type === 'goto') {
      controller.goto(msg.index);
    } else if (msg.type === 'command') {
      void vscode.commands.executeCommand(`showme.${msg.command}`);
    }
  });
  controller.revealUi = () => sidebar.reveal();
  controller.onDidChange((snap) => {
    sidebar.update(snap);
    statusBar.update(snap);
  });

  const watcher = new TourWatcher((uri) => {
    if (vscode.workspace.getConfiguration('showme').get<boolean>('autoPlayNewTours', true)) {
      log(`[watch] new tour ${vscode.workspace.asRelativePath(uri)}`);
      void controller.playFile(uri);
    }
  });

  const command = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    output,
    presenter,
    tts,
    controller,
    statusBar,
    watcher,
    { dispose: () => audio.stop() },
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    command('showme.playTour', async (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : await pickTour();
      if (target) await controller.playFile(target);
    }),
    command('showme.replayTour', () => controller.replayTour()),
    command('showme.togglePause', () => controller.player.togglePause()),
    command('showme.next', () => controller.player.next()),
    command('showme.previous', () => controller.player.previous()),
    command('showme.replay', () => controller.player.replay()),
    command('showme.stop', () => controller.stop()),
    command('showme.playDemo', () =>
      controller.playFile(vscode.Uri.joinPath(context.extensionUri, 'examples', 'demo.tour.json')),
    ),
    command('showme.installSkill', () => installSkill(context)),
    command('showme.testVoice', async () => {
      try {
        const clips = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'ShowMe: preparing voice…' },
          () => tts.speakOnce("Hi! I'm your ShowMe narrator. Ask your agent to show you some code, and I'll walk you through it."),
        );
        void vscode.window.setStatusBarMessage(`ShowMe voice: ${tts.label}`, 6000);
        for (const clip of clips) await audio.play(clip);
      } catch (err) {
        void vscode.window.showErrorMessage(`ShowMe: voice test failed: ${(err as Error).message}`);
      }
    }),
  );

  log(`[showme] activated (${process.platform}, node ${process.version}, exec ${process.execPath})`);
  void playRecentTour(controller, log);
}

/** A tour written while this window was still starting up would otherwise be missed by the watcher. */
async function playRecentTour(controller: Controller, log: (line: string) => void): Promise<void> {
  if (!vscode.workspace.getConfiguration('showme').get<boolean>('autoPlayNewTours', true)) return;
  const [newest] = await listTours();
  if (newest && Date.now() - newest.mtime < 30_000 && !controller.hasTour) {
    log(`[watch] playing tour written during startup: ${vscode.workspace.asRelativePath(newest.uri)}`);
    await controller.playFile(newest.uri);
  }
}

export function deactivate(): void {
  // Disposables registered on the context handle cleanup.
}
