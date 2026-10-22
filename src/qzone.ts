// QQ 空间（事件驱动版）。
//
// 设计：本模块**不再调用任何第二模型**（独立的 LLM 地址/密钥/模型）。
// - 自动发动态：调度器到点只推一条 nudge 事件，由主模型用 qq_qzone（action=post） 工具发布（content 须由主模型显式给出）。
// - 评论自动回复：收到评论后推一条 nudge 事件，由主模型用 qq_qzone（action=reply） 工具回复。
// 这样动态/评论的内容都由主模型决定，语气与人格一致，且不需要单独的模型配置。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import type { QQApi } from './types.ts';
import type { QQIdentity } from './definition.ts';
import type { QZoneConfig } from './config.ts';

export interface QZoneAutoReplyConfig {
  enabled: boolean;
  dailyQuota: number;
  cooldownSec: number;
}

export interface QZoneConfig {
  /** 是否启用 QQ 空间（动态/评论回复）。 */
  enabled: boolean;
  /** 自动冒泡：每 tick 概率发一条动态。 */
  tickSec: number;
  /** 每个 tick 自动发动态的概率（0~1）。 */
  chancePerTick: number;
  /** 每天自动发动态上限（0=不限）。 */
  dailyQuota: number;
  /** 权限：谁可触发/发；与原来一致。 */
  permission: 'all' | 'friend' | 'admin' | 'owner';
  /** 动态配图模式。 */
  imageMode: 'none' | 'recent' | 'album';
  /** 评论动作：自动回复 / 仅记录。 */
  commentAction: 'auto' | 'none';
  autoReplyComments: QZoneAutoReplyConfig;
}

export interface QZonePosterOptions {
  cfg: QZoneConfig;
  log: (...a: unknown[]) => void;
  dataDir: string;
  callApi: (action: string, params: Record<string, unknown>) => Promise<{ data?: unknown; error?: string }>;
  getContext: () => string;
  getRecentImageUrl: () => string | null;
  isPaused: () => boolean;
  /** 评论 ingestion：把评论作为外部事件喂给框架（沉淀记忆）。 */
  pushEvent: (e: unknown) => void;
  /** 由 world 注入：把"请主模型发一条动态/回一条评论"的请求交给主模型（事件驱动，不再用第二模型）。 */
  requestLLM: (nudge: string, kind: 'post' | 'reply', meta?: Record<string, unknown>) => void;
  identity: () => QQIdentity;
}

interface QZoneState {
  dailyCount: number;
  replyDailyCount: number;
  day: string;
  lastReplyAt: number;
  lastPosts: Array<{ tid: string; text: string }>;
}

export type QZonePostResult = { ok: true; tid?: string; text?: string } | { ok: false; error: string };

export class QZonePoster {
  private readonly cfg: QZoneConfig;
  private readonly log: (...a: unknown[]) => void;
  private readonly dataDir: string;
  private readonly callApi: (action: string, params: Record<string, unknown>) => Promise<{ data?: unknown; error?: string }>;
  private readonly getContext: () => string;
  private readonly getRecentImageUrl: () => string | null;
  private readonly isPaused: () => boolean;
  private readonly pushEvent: (e: unknown) => void;
  private readonly requestLLM: (nudge: string, kind: 'post' | 'reply', meta?: Record<string, unknown>) => void;
  private readonly identity: () => QQIdentity;

  private state: QZoneState = { dailyCount: 0, replyDailyCount: 0, day: '', lastReplyAt: 0, lastPosts: [] };
  private timer?: ReturnType<typeof setInterval>;
  private readonly scheduleKey = 'qzone-state.json';

  constructor(opts: QZonePosterOptions) {
    this.cfg = opts.cfg;
    this.log = opts.log;
    this.dataDir = opts.dataDir;
    this.callApi = opts.callApi;
    this.getContext = opts.getContext;
    this.getRecentImageUrl = opts.getRecentImageUrl;
    this.isPaused = opts.isPaused;
    this.pushEvent = opts.pushEvent;
    this.requestLLM = opts.requestLLM;
    this.identity = opts.identity;
    this.load();
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  get scheduled(): boolean {
    return this.cfg.enabled && this.cfg.chancePerTick > 0;
  }

  start(): void {
    if (this.timer) return;
    const sec = Math.max(10, this.cfg.tickSec || 600);
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error('tick error', e)), sec * 1000);
    this.log.info('started', { tickSec: sec });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 发动态：content 须由调用方（主模型经 qq_qzone（action=post））显式提供。删除了"模型自动生成"路径。 */
  async post(opts: { content: string; images?: string[]; topic?: string; permission?: string }): Promise<QZonePostResult> {
    if (!this.cfg.enabled) return { ok: false, error: 'QQ 空间未启用（先在控制台开 worlds.qqbot.qzone.enabled）。' };
    const content = (opts.content || '').trim();
    if (!content) return { ok: false, error: '动态内容不能为空：请用 content 给出要发的内容（本扩展不再自动生成动态文本）。' };
    if (this.cfg.dailyQuota > 0 && this.state.dailyCount >= this.cfg.dailyQuota) {
      return { ok: false, error: `今天自动发动态已达上限（${this.cfg.dailyQuota}），请明天再发，或手动发。` };
    }
    const params: Record<string, unknown> = {
      content_type: 1,
      content,
      // 模型提供的附图经白名单过滤；bot 自己收到的本地图片（collectImages）是可信内部来源，不经此过滤。
      images: this.sanitizeImages(opts.images) ?? (this.cfg.imageMode !== 'none' ? this.collectImages() : []),
    };
    if (opts.topic) params.topic = opts.topic;
    const perm = opts.permission ?? String(this.cfg.permission ?? 'all');
    params.visible = { type: perm === 'all' ? 1 : perm === 'friend' ? 2 : perm === 'admin' ? 4 : 8 };
    const res = await this.callApi('qzone.publish', params);
    if (res.error) return { ok: false, error: `发布失败：${res.error}` };
    const tid = String((res.data as { tid?: string })?.tid ?? '');
    this.recordPost(tid, content);
    this.log.info('posted', { tid });
    return { ok: true, tid, text: content };
  }

  /** 回复某条评论（由主模型经 qq_qzone（action=reply） 调用）。 */
  async replyComment(commentId: string, text: string, tid?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!commentId) return { ok: false, error: '缺少 commentId。' };
    const res = await this.callApi('qzone.replyComment', { commentId, text, tid });
    if (res.error) return { ok: false, error: `回复失败：${res.error}` };
    this.log.info('replied comment', { commentId });
    return { ok: true };
  }

  async getFeeds(num: number): Promise<{ ok: boolean; feeds?: unknown[]; error?: string }> {
    if (!this.cfg.enabled) return { ok: false, error: 'QQ空间未启用' };
    const res = await this.callApi('qzone.feeds', { num });
    if (res.error) return { ok: false, error: res.error };
    const data = (res.data ?? {}) as { feeds?: unknown[] };
    return { ok: true, feeds: data.feeds ?? [] };
  }

  async delete(tid: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.callApi('qzone.delete', { tid });
    if (res.error) return { ok: false, error: res.error };
    return { ok: true };
  }

  private collectImages(): string[] {
    if (this.cfg.imageMode === 'none') return [];
    const url = this.getRecentImageUrl();
    return url ? [url] : [];
  }

  /**
   * 校验模型经 qq_qzone(action=post) 提供的附图链接：仅收 http(s):// 与 data: 图片（base64://）；
   * 拒绝 file:// 等本地/任意协议，避免模型借附图把本机任意文件上传出去（纵深防御：
   * world 层已过滤一次，这里作为真正调 API 的边界再挡一道）。
   */
  private sanitizeImages(urls: string[] | undefined): string[] | undefined {
    if (!urls || !urls.length) return undefined;
    // 仅收 http(s):// 与 base64:// / data: 图片数据；拒绝 file:// 等本地/任意协议，避免模型借附图把本机任意文件上传出去。
    return urls.filter(
      (u) =>
        typeof u === 'string' &&
        (/^https?:\/\//.test(u) || /^base64:\/\//.test(u) || /^data:image\//i.test(u)),
    );
  }

  /** 评论事件：沉淀为外部事件 + 若开启自动回复则请主模型回复。 */
  onEvent(e: { type?: string; data?: Record<string, unknown> }): void {
    const data = (e.data ?? {}) as Record<string, unknown>;
    if (e.type !== 'qq.message.comment.new') return;
    const tid = String(data.tid ?? '');
    const commentId = String(data.commentId ?? '');
    if (!commentId) return;
    const p = data as { text?: string; operatorNick?: string };
    // 1) 把评论作为外部事件喂给框架（沉淀记忆、让 bot「看见」）
    this.pushEvent({
      type: 'qq.qzone.comment',
      origin: 'external',
      source: 'qq',
      senderKey: `qzone:${tid}`,
      text: `QQ空间评论 ${p.operatorNick ? '(' + p.operatorNick + ')' : ''}：${p.text ?? ''}`,
      meta: { conv: `qzone:${tid}`, tid, commentId },
    });
    // 2) 自动回复：事件驱动（请主模型调 qq_qzone（action=reply）），不再用第二模型生成
    if (this.cfg.commentAction !== 'auto' || !this.cfg.autoReplyComments.enabled) return;
    this.rolloverDay();
    const now = Date.now();
    if (now - this.state.lastReplyAt < this.cfg.autoReplyComments.cooldownSec * 1000) return;
    if (this.cfg.autoReplyComments.dailyQuota > 0 && this.state.replyDailyCount >= this.cfg.autoReplyComments.dailyQuota) return;
    this.state.lastReplyAt = now;
    this.state.replyDailyCount += 1;
    this.save();
    // 评论原文（来自任意评论者，不可信）放进 meta；text 只放指令，不含外部内容。
    const nudge = '你的 QQ 空间动态下有一条新评论。请用 qq_qzone（action=reply） 工具回复，自然一句话，可带 emoji，别客套别太长。评论原文、评论者、tid、comment_id 都在事件 meta 里。';
    this.requestLLM(nudge, 'reply', {
      tid,
      commentId,
      operatorNick: p.operatorNick || '对方',
      original: p.text ?? '',
    });
  }

  private async tick(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.isPaused()) return;
    this.rolloverDay();
    if (this.cfg.dailyQuota > 0 && this.state.dailyCount >= this.cfg.dailyQuota) return;
    if (Math.random() >= this.cfg.chancePerTick) return;
    const ctx = this.getContext().slice(-3000);
    const nudge =
      '请你以第一人称主动发一条 QQ 空间动态（说说），可用 qq_qzone（action=post） 工具发布。' +
      '内容像你自己真实的朋友圈碎碎念：对最近聊天里某件事/某个人发表真实看法、吐槽、安利或简介，或分享当下心情。' +
      '自然、有梗、带点小情绪，1-3 句最佳，最多不超 100 字，可带少量 emoji，不要客服腔。' +
      '最近聊天的取材放在事件 meta.context 里，可据此发挥。';
    this.requestLLM(nudge, 'post', ctx ? { context: ctx } : {});
  }

  private rolloverDay(): void {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== this.state.day) {
      this.state.day = d;
      this.state.dailyCount = 0;
      this.state.replyDailyCount = 0;
    }
  }

  private recordPost(tid: string, text: string): void {
    this.rolloverDay();
    this.state.dailyCount += 1;
    this.state.lastPosts.unshift({ tid, text });
    if (this.state.lastPosts.length > 10) this.state.lastPosts.pop();
    this.save();
  }

  status(): { enabled: boolean; dailyQuota: number; dailyCount: number; autoReply: boolean; replyDailyCount: number; lastPosts: Array<{ tid: string; text: string }> } {
    return {
      enabled: this.cfg.enabled,
      dailyQuota: this.cfg.dailyQuota,
      dailyCount: this.state.dailyCount,
      autoReply: this.cfg.commentAction === 'auto' && this.cfg.autoReplyComments.enabled,
      replyDailyCount: this.state.replyDailyCount,
      lastPosts: this.state.lastPosts,
    };
  }

  // ---- 持久化（保留，用于每日配额/冷却判定 + 最近动态展示） ----
  private load(): void {
    try {
      const file = path.join(this.dataDir, this.scheduleKey);
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof raw.dailyCount === 'number') this.state.dailyCount = raw.dailyCount;
        if (typeof raw.replyDailyCount === 'number') this.state.replyDailyCount = raw.replyDailyCount;
        if (typeof raw.day === 'string') this.state.day = raw.day;
        if (typeof raw.lastReplyAt === 'number') this.state.lastReplyAt = raw.lastReplyAt;
        if (Array.isArray(raw.lastPosts)) this.state.lastPosts = raw.lastPosts;
      }
    } catch (e) {
      this.log.warn('load failed', e);
    }
  }

  private save(): void {
    try {
      const file = path.join(this.dataDir, this.scheduleKey);
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.state), 'utf8');
    } catch (e) {
      this.log.warn('save failed', e);
    }
  }
}
