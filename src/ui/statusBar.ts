import * as vscode from 'vscode';
import type { ViewSnapshot } from '../controller';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('showme.status', vscode.StatusBarAlignment.Left, 50);

  constructor() {
    this.item.name = 'ShowMe';
    this.item.command = 'showme.togglePause';
  }

  update(s: ViewSnapshot): void {
    if (s.state === 'idle') {
      this.item.hide();
      return;
    }
    const pos = s.total ? ` ${s.index + 1}/${s.total}` : '';
    switch (s.state) {
      case 'loading':
        this.item.text = '$(loading~spin) ShowMe: preparing…';
        this.item.tooltip = 'Loading the tour and the voice';
        break;
      case 'playing':
        this.item.text = `$(debug-pause) ShowMe${pos}`;
        this.item.tooltip = 'Pause (Ctrl+Alt+Space) · Next (Ctrl+Alt+→) · Previous (Ctrl+Alt+←)';
        break;
      case 'paused':
        this.item.text = `$(play) ShowMe${pos} · paused`;
        this.item.tooltip = 'Resume (Ctrl+Alt+Space)';
        break;
      case 'waiting':
        this.item.text = `$(arrow-right) ShowMe${pos} · next`;
        this.item.tooltip = 'Continue to the next step (Ctrl+Alt+Space)';
        break;
      case 'finished':
        this.item.text = `$(check) ShowMe · done`;
        this.item.tooltip = 'Tour finished. Click to play it again.';
        break;
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
