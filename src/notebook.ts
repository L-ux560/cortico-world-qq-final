import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Logger } from 'cortico/core/types.ts';

/**
 * 智能体私人笔记本（本地后端）。
 *
 * 曾经经一个全局桥接键把笔记写入 cortico-world-memory 的笔记库。认证评审
 * （Pal-AI-Lab/cortico-extensions#104）指出：World 之间不得直接调用，且 `qq_note`
 * 与记忆扩展自带的 `mem_note`/`mem_notes`/`mem_forget_note` 功能重复——两个都装时
 * 模型直接用后者即可。**桥接已移除**，本笔记本只写本地 `notebook.jsonl`，
 * 不 import、不探测任何其他 World。
 */

export interface NotebookEntry {
  id: string;
  text: string;
  ts: number;
}

/**
 * 智能体私人笔记本：让 AI 记录自己想记的东西。
 * - 只落本插件 dataDir/notebook.jsonl（原生），用稳定字符串 id。
 * - 与 cortico-world-memory 的笔记功能重复；两个都装时模型应优先用
 *   `mem_note`/`mem_notes`/`mem_forget_note`（常驻提示词 + 混合检索）。
 */
export class Notebook {
  private readonly file: string;

  constructor(private readonly dataDir: string, private readonly log?: Logger) {
    this.file = join(dataDir, 'notebook.jsonl');
  }

  /** 当前实际使用的后端（固定为 native：本地 JSONL）。 */
  get backend(): 'native' {
    return 'native';
  }

  private loadNative(): NotebookEntry[] {
    try {
      const raw = readFileSync(this.file, 'utf8');
      return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as NotebookEntry);
    } catch {
      return [];
    }
  }

  private saveNative(entries: NotebookEntry[]): void {
    const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
    writeFileSync(this.file, body, 'utf8');
  }

  async save(text: string): Promise<{ id: string; backend: string }> {
    const t = text.trim();
    if (!t) return { id: '', backend: this.backend };
    const entries = this.loadNative();
    const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    entries.push({ id, text: t, ts: Date.now() });
    this.saveNative(entries);
    return { id, backend: 'native' };
  }

  async list(): Promise<Array<NotebookEntry & { seq?: number }>> {
    return this.loadNative();
  }

  async get(id: string): Promise<NotebookEntry | null> {
    return this.loadNative().find((e) => e.id === id) ?? null;
  }

  async forget(id: string): Promise<boolean> {
    const entries = this.loadNative();
    const i = entries.findIndex((e) => e.id === id);
    if (i < 0) return false;
    entries.splice(i, 1);
    this.saveNative(entries);
    return true;
  }
}
