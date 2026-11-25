/**
 * Puts a step on screen: opens the file, scrolls the range into the middle, highlights it,
 * fades the rest of the file, and shows the narration in a comment bubble under the code.
 */
import * as vscode from 'vscode';
import { resolveRange } from '../tour/anchor';

export interface PresentableStep {
  index: number;
  total: number;
  title?: string;
  narration: string;
  uri?: vscode.Uri;
  lines?: [number, number];
  anchor?: string;
}

export interface PresentResult {
  /** Lines actually highlighted (after anchor resolution), 1-based. */
  shownLines?: [number, number];
  warning?: string;
  /** The file could not be opened. */
  missing?: boolean;
}

export class Presenter implements vscode.Disposable {
  private readonly highlight: vscode.TextEditorDecorationType;
  private readonly dim: vscode.TextEditorDecorationType;
  private readonly comments: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private thread: vscode.CommentThread | undefined;
  private current: { uri: vscode.Uri; range?: vscode.Range } | undefined;
  private column: vscode.ViewColumn | undefined;

  constructor(private readonly iconUri: vscode.Uri) {
    this.highlight = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('showme.highlightBackground'),
      borderColor: new vscode.ThemeColor('showme.highlightBorder'),
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      overviewRulerColor: new vscode.ThemeColor('showme.highlightBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    this.dim = vscode.window.createTextEditorDecorationType({ opacity: '0.45' });
    this.comments = vscode.comments.createCommentController('showme', 'ShowMe');
    // No commentingRangeProvider: we never want the "+" add-comment affordance in the gutter.

    this.disposables.push(
      this.highlight,
      this.dim,
      this.comments,
      vscode.window.onDidChangeVisibleTextEditors(() => this.reapply()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('showme.dimOtherLines')) this.reapply();
      }),
    );
  }

  /** Called when a new tour starts, so all its steps open in the same editor group. */
  beginTour(): void {
    this.column = undefined;
  }

  async show(step: PresentableStep): Promise<PresentResult> {
    this.clearThread();

    if (!step.uri) {
      // Narration-only step (intro / recap): keep the editor as is, just drop the highlight.
      this.current = undefined;
      this.reapply();
      return {};
    }

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(step.uri);
    } catch {
      this.current = undefined;
      this.reapply();
      return { missing: true };
    }

    let range: vscode.Range | undefined;
    let result: PresentResult = {};
    if (step.lines) {
      const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);
      const r = resolveRange(lines, step.lines[0], step.lines[1], step.anchor);
      range = new vscode.Range(r.start - 1, 0, r.end - 1, doc.lineAt(r.end - 1).text.length);
      result = { shownLines: [r.start, r.end], warning: r.warning };
    }

    this.column ??= vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: this.column,
      preserveFocus: true,
      preview: true,
    });

    this.current = { uri: doc.uri, range };
    this.reapply();

    if (range) {
      const visible = visibleLineCount(editor);
      const tall = range.end.line - range.start.line + 1 > visible - 6;
      editor.revealRange(range, tall ? vscode.TextEditorRevealType.AtTop : vscode.TextEditorRevealType.InCenter);
    } else {
      editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    }

    if (vscode.workspace.getConfiguration('showme').get<boolean>('inlineCaptions')) {
      this.showCaption(doc.uri, range ?? new vscode.Range(0, 0, 0, 0), step);
    }
    return result;
  }

  clear(): void {
    this.clearThread();
    this.current = undefined;
    this.reapply();
  }

  dispose(): void {
    this.clear();
    this.disposables.forEach((d) => d.dispose());
  }

  private showCaption(uri: vscode.Uri, range: vscode.Range, step: PresentableStep): void {
    const body = new vscode.MarkdownString(step.narration);
    body.supportThemeIcons = true;
    const comment: vscode.Comment = {
      author: {
        name: `Step ${step.index + 1} of ${step.total}${step.title ? ` · ${step.title}` : ''}`,
        iconPath: this.iconUri,
      },
      body,
      mode: vscode.CommentMode.Preview,
    };
    const anchorLine = new vscode.Range(range.end.line, 0, range.end.line, 0);
    const thread = this.comments.createCommentThread(uri, anchorLine, [comment]);
    thread.canReply = false;
    thread.label = 'ShowMe';
    thread.contextValue = 'showme';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.thread = thread;
  }

  private clearThread(): void {
    this.thread?.dispose();
    this.thread = undefined;
  }

  /** (Re)applies decorations to every visible editor; editors get re-created when tabs switch. */
  private reapply(): void {
    const dimOthers = vscode.workspace.getConfiguration('showme').get<boolean>('dimOtherLines');
    for (const editor of vscode.window.visibleTextEditors) {
      const cur = this.current;
      if (!cur?.range || editor.document.uri.toString() !== cur.uri.toString()) {
        editor.setDecorations(this.highlight, []);
        editor.setDecorations(this.dim, []);
        continue;
      }
      const { range } = cur;
      editor.setDecorations(this.highlight, [range]);
      if (dimOthers) {
        const last = editor.document.lineCount - 1;
        const dims: vscode.Range[] = [];
        if (range.start.line > 0) dims.push(new vscode.Range(0, 0, range.start.line - 1, Number.MAX_SAFE_INTEGER));
        if (range.end.line < last) dims.push(new vscode.Range(range.end.line + 1, 0, last, Number.MAX_SAFE_INTEGER));
        editor.setDecorations(this.dim, dims);
      } else {
        editor.setDecorations(this.dim, []);
      }
    }
  }
}

function visibleLineCount(editor: vscode.TextEditor): number {
  const r = editor.visibleRanges[0];
  return r ? r.end.line - r.start.line + 1 : 40;
}
