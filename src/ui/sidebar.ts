/** Activity-bar view: current caption, playback controls and the clickable list of steps. */
import * as vscode from 'vscode';
import type { ViewSnapshot } from '../controller';

export type SidebarMessage =
  | { type: 'ready' }
  | { type: 'command'; command: 'togglePause' | 'next' | 'previous' | 'replay' | 'stop' | 'playTour' | 'playDemo' | 'installSkill' | 'replayTour' }
  | { type: 'goto'; index: number };

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'showme.sidebar';
  private view: vscode.WebviewView | undefined;
  private last: ViewSnapshot | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (msg: SidebarMessage) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((msg: SidebarMessage) => {
      if (msg.type === 'ready') {
        if (this.last) void view.webview.postMessage({ type: 'state', snapshot: this.last });
      } else {
        this.onMessage(msg);
      }
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  update(snapshot: ViewSnapshot): void {
    this.last = snapshot;
    void this.view?.webview.postMessage({ type: 'state', snapshot });
  }

  /** Brings the view on screen without stealing keyboard focus when possible. */
  reveal(): void {
    if (this.view) {
      this.view.show(true);
    } else {
      void vscode.commands.executeCommand('workbench.view.extension.showme');
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>ShowMe</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
