import * as vscode from 'vscode';
import { previewDimensions } from './media';
import { imageSizeFromFile } from 'image-size/fromFile';

export async function imagePreviewMarkup(file: string, doc: vscode.TextDocument): Promise<string> {
  // Native hovers have their own maximum height (often 250px). Reserve room for
  // Markdown margins, labels, the open link and the hover toolbar, not just the image.
  let maxHeight = 160;
  for (const editor of vscode.window.visibleTextEditors.filter(e => e.document === doc)) {
    const config = vscode.workspace.getConfiguration('editor', doc.uri);
    const fontSize = config.get<number>('fontSize', 14);
    const configured = config.get<number>('lineHeight', 0);
    const lineHeight = configured >= 8 ? configured : fontSize * (configured > 0 ? configured : 1.5);
    const lines = editor.visibleRanges.reduce((n, r) => n + r.end.line - r.start.line + 1, 0);
    // Logical lines underestimate wrapped lines, which errs toward a smaller preview.
    maxHeight = Math.min(maxHeight, Math.max(24, Math.floor(lines * lineHeight / 2 - 80)));
  }
  const size = previewDimensions(await imageSizeFromFile(file), { width: 240, height: maxHeight });
  return `<img src="${vscode.Uri.file(file).toString()}" width="${size.width}" height="${size.height}">`;
}
