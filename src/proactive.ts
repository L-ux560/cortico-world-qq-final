// 主动说话调度器（事件驱动版）。
//
// 设计：本模块**不再调用任何第二模型**（独立的 LLM 地址/密钥/模型）。
// 主动说话 / 作息播报只负责「决定现在要不要说、对每个会话构造一句 nudge」，
// 然后把 nudge 交给主模型生成并发送——由 world 通过 `host.pushEvent(..., origin:'internal')`
// 触发一轮主模型回合，主模型输出（或主动调 qq_send）即送达该会话。
// 这样主模型决定「说什么」，语气/分寸与正常对话一致，且不需要单独的模型配置。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import type { ActiveGroup, ActivePrivate } from './world.ts';
import type { ProactiveConfig } from './config.ts';

export type ProactiveTarget = ActiveGroup | ActivePrivate;

export interface RoutineConfig {
  enabled: boolean;
  sleepStart: string;
  sleepEnd: string;
  lazyStart: string;
  lazyEnd: string;
  greetSleep: string;
  greetWake: string;
  greetLazy: string;
}

export class Routine {
  constructor(private readonly cfg: RoutineConfig, private readonly log: (...a: unknown[]) => void) {}

  segment(): string | null {
    if (!this.cfg.enabled) return null;
    return routineSegment(this.cfg);
  }

  isLunchBreak(): boolean {
    return this.cfg.enabled && inRange(this.cfg.lazyStart, this.cfg.lazyEnd);
  }

  isSleep(): boolean {
    return this.cfg.enabled && inRange(this.cfg.sleepStart, this.cfg.sleepEnd);
  }

  /** 当前作息切到了哪个阶段（用于到点播报）。返回 null 表示没切。 */
  phase(scene: 'sleep' | 'noon' | 'wake'): 'on' | 'off' | null {
    if (!this.cfg.enabled) return null;
    if (scene === 'sleep') return this.isSleep() ? 'on' : 'off';
    if (scene === 'noon') return this.isLunchBreak() ? 'on' : 'off';
    return this.isSleep() ? 'off' : 'on';
  }

  /** 到点播报文案（很短，主模型可原样用作碎碎念，也可自行发挥）。优先用配置里的问候语，缺省时回退到内置文案。 */
  announceText(scene: 'sleep' | 'noon' | 'wake'): string {
    if (scene === 'sleep') return this.cfg.greetSleep || '到点睡啦，先去躺着，明天再聊～';
    if (scene === 'noon') return this.cfg.greetLazy || '午休一下，吃饱喝足再战。';
    return this.cfg.greetWake || '醒啦，新的一天开始咯。';
  }
}

export function inRange(start: string, end: string): boolean {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s <= e) return cur >= s && cur < e;
  return cur >= s || cur < e;
}

function routineSegment(cfg: RoutineConfig): string {
  const parts: string[] = [];
  if (cfg.enabled) {
    parts.push(`你的作息：约 ${cfg.sleepStart}–${cfg.sleepEnd} 睡眠（睡眠段不主动冒泡），约 ${cfg.lazyStart}–${cfg.lazyEnd} 午休（午休段语气可以随意点，但别太长）。`);
  }
  return parts.length ? '## AI 作息（routine）\n' + parts.join('\n') : null;
}

export interface ProactiveSpeakerOptions {
  cfg: ProactiveConfig;
  log: (...a: unknown[]) => void;
  dataDir: string;
  getTargets: () => ProactiveTarget[];
  routine: RoutineConfig;
  selfName: string;
  /** 由 world 注入：把"要主动说点什么"的请求交给主模型生成并发送。pending=true 时标记该会话为"本轮待回"，否则（如作息播报）由主模型自行调 qq_send。 */
  requestSpeech: (target: ProactiveTarget, nudge: string, pending: boolean) => void;
}

interface State {
  lastSent: number;
  unreplied: number;
  firstMessageSent: boolean;
}

export class ProactiveSpeaker {
  private readonly cfg: ProactiveConfig;
  private readonly log: (...a: unknown[]) => void;
  private readonly dataDir: string;
  private readonly getTargets: () => ProactiveTarget[];
  private readonly routine: RoutineConfig;
  private readonly selfName: string;
  private readonly requestSpeech: (target: ProactiveTarget, nudge: string, pending: boolean) => void;

  private readonly states = new Map<string, State>();
  private readonly recent: string[] = [];
  private dailyCount = 0;
  private day = '';
  private lastRoutineSegment: 'sleep' | 'lazy' | 'active' | '' = '';
  private timer?: ReturnType<typeof setInterval>;
  private readonly scheduleKey = 'proactive-state.json';

  constructor(opts: ProactiveSpeakerOptions) {
    this.cfg = opts.cfg;
    this.log = opts.log;
    this.dataDir = opts.dataDir;
    this.getTargets = opts.getTargets;
    this.routine = opts.routine;
    this.selfName = opts.selfName;
    this.requestSpeech = opts.requestSpeech;
    this.load();
  }

  start(): void {
    if (this.timer) return;
    const sec = Math.max(5, this.cfg.tickSec || 30);
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error('tick error', e)), sec * 1000);
    this.log.info('started', { tickSec: sec });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  notifyReply(address: string): void {
    const s = this.states.get(address);
    if (s) s.unreplied = 0;
    this.save();
  }

  private now(): number {
    return Date.now();
  }

  private hhmm(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  private isDayRolled(): boolean {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.dailyCount = 0;
      return true;
    }
    return false;
  }

  private label(t: ProactiveTarget): string {
    return t.kind === 'group' ? `群「${t.name}」` : `私聊 ${t.name || (t as ActivePrivate).qq}`;
  }

  private ensure(address: string): State {
    let s = this.states.get(address);
    if (!s) {
      s = { lastSent: 0, unreplied: 0, firstMessageSent: false };
      this.states.set(address, s);
    }
    return s;
  }

  private pushRecent(text: string): void {
    this.recent.push(text);
    const cap = Math.max(1, this.cfg.dedupWindow || 10);
    while (this.recent.length > cap) this.recent.shift();
  }

  /** 构造交给主模型的"主动说话"提示（不再自己生成文本）。 */
  private buildNudge(t: ProactiveTarget, forced: boolean): string {
    const who = this.cfg.withNickname ? `（你在和 ${this.label(t)} 说话）` : '';
    const hint = forced ? '（这是被手动触发的主动说话，请务必说点有意思的。）' : '';
    const r = this.routine;
    const lazy = !!(r?.enabled && (inRange(r.lazyStart, r.lazyEnd) || inRange(r.sleepStart, r.sleepEnd)));
    const lazyNote = lazy ? '（当前是午休/睡眠时段，简短随意点就行。）' : '';
    return (
      `你现在决定主动向 ${this.label(t)} 说一句话（这是主动冒泡，不是回复）。` +
      `${who}聊点自然轻松的：关心一下、抛个小话题、分享当下心情或碎碎念都行。` +
      `一两句就够，别太长太正式，别客服腔，也别每条都问"在吗/吃了吗"。` +
      `只聊你们真实对话里出现过的事；没什么可接的就泛泛关心/问候。绝不要编造没发生过的事件或细节。` +
      `${hint}${lazyNote}`
    );
  }

  private canSpeak(t: ProactiveTarget): boolean {
    if (!this.cfg.enabled) return false;
    this.isDayRolled();
    const now = this.now();
    const s = this.ensure(t.address);
    const cd = t.kind === 'group' ? this.cfg.groupCooldownSec : this.cfg.privateCooldownSec;
    if (now - s.lastSent < cd * 1000) return false;
    if (s.unreplied >= this.cfg.unrepliedThreshold) return false;
    if (this.cfg.dailyQuota > 0 && this.dailyCount >= this.cfg.dailyQuota) return false;
    return true;
  }

  private pick(): ProactiveTarget | null {
    const targets = this.getTargets().filter((t) => {
      if (this.cfg.mode === 'private') return t.kind === 'private';
      if (this.cfg.mode === 'group') return t.kind === 'group';
      return true;
    });
    if (!targets.length) return null;
    const now = this.now();
    const scored = targets.map((t) => {
      const s = this.ensure(t.address);
      const age = now - s.lastSent;
      const cd = t.kind === 'group' ? this.cfg.groupCooldownSec : this.cfg.privateCooldownSec;
      const warm = s.state === 'warmup' && !this.firstMessageSent(t);
      const p = warm ? this.cfg.warmupChance : this.cfg.stableChancePerTick;
      return { t, score: Math.min(1, age / (cd * 1000)) * p + (s.unreplied > 0 ? 0.15 : 0) };
    });
    // 按分数随机选一个（偏向冷却久 + 未回复）
    scored.sort((a, b) => b.score - a.score);
    const r = Math.random();
    let acc = 0;
    for (const x of scored) {
      acc += x.score;
      if (r < acc) return x.t;
    }
    return scored[0]?.t ?? null;
  }

  private firstMessageSent(address: string): boolean {
    return this.ensure(address).firstMessageSent;
  }

  private async tick(): Promise<void> {
    if (!this.cfg.enabled) return;
    // 作息：睡眠段不主动冒泡，并在时段切换时主动播报（去睡/醒/午休）。
    if (this.routine.enabled) {
      const r = this.routine;
      const seg: 'sleep' | 'lazy' | 'active' =
        inRange(r.sleepStart, r.sleepEnd) ? 'sleep'
        : inRange(r.lazyStart, r.lazyEnd) ? 'lazy'
        : 'active';
      if (seg !== this.lastRoutineSegment) {
        if (this.lastRoutineSegment) await this.announceRoutine(this.lastRoutineSegment, seg);
        this.lastRoutineSegment = seg;
        this.save();
      }
      if (seg === 'sleep') return; // 睡眠段：不主动冒泡（被找仍会被动回复）
    }
    this.isDayRolled();
    if (this.cfg.dailyQuota > 0 && this.dailyCount >= this.cfg.dailyQuota) return;
    const chance = this.anyFirstMessageSent() ? this.cfg.stableChancePerTick : this.cfg.warmupChance;
    if (Math.random() > chance) return;
    const target = this.pick();
    if (!target) return;
    if (!this.canSpeak(target)) return;
    this.emit(target, false);
  }

  private anyFirstMessageSent(): boolean {
    for (const s of this.states.values()) if (s.firstMessageSent) return true;
    return false;
  }

  /** 主动说话（事件驱动）：交由主模型生成并发送。返回是否发出了请求。 */
  private emit(t: ProactiveTarget, forced: boolean): boolean {
    const s = this.ensure(t.address);
    s.lastSent = this.now();
    s.unreplied += 1;
    if (s.state === 'warmup' && !this.firstMessageSent(t.address)) s.firstMessageSent = true;
    this.dailyCount += 1;
    this.pushRecent(`[${this.hhmm()}] 主动→${this.label(t)}`);
    this.save();
    const nudge = this.buildNudge(t, forced);
    this.requestSpeech(t, nudge, true);
    this.log.info('已请求主模型主动发送', { address: t.address });
    return true;
  }

  /** 时段切换时，向所有可主动说话的会话播报一句（事件驱动：主模型经 qq_send 说，不强制）。 */
  announceRoutine(prev: string, seg: 'sleep' | 'lazy' | 'active'): void {
    let scene: 'sleep' | 'noon' | 'wake' | '' = '';
    let fallback = '';
    if (seg === 'sleep') { scene = 'sleep'; fallback = new Routine(this.routine, this.log).announceText('sleep'); }
    else if (seg === 'lazy') { scene = 'noon'; fallback = new Routine(this.routine, this.log).announceText('noon'); }
    else if (seg === 'active' && prev === 'sleep') { scene = 'wake'; fallback = new Routine(this.routine, this.log).announceText('wake'); }
    else return; // 其它切换（如 lazy→active 午休结束）不播报
    const targets = this.getTargets().filter((t) => {
      if (this.cfg.mode === 'private') return t.kind === 'private';
      if (this.cfg.mode === 'group') return t.kind === 'group';
      return true;
    });
    for (const t of targets) {
      const sceneText = scene === 'sleep' ? '去睡觉' : scene === 'noon' ? '去午休/打盹' : '刚睡醒起床';
      const nudge =
        `【作息播报·${sceneText}】现在是我作息时段切换的时刻。` +
        `请用你自己的口吻、自然地说一句这种场景下的话（一两句，别太长别太正式，别客服腔，不要加"在吗"）。` +
        `每次可以换种说法，不要念固定套话。` +
        (fallback ? `（如果不知道说什么，可以说：「${fallback}」）` : '如果你觉得没什么好说的，也可以不发。');
      this.requestSpeech(t, nudge, false);
    }
    this.log.info('作息时段切换播报', { from: prev, to: seg });
  }

  trigger(target?: ProactiveTarget): string {
    const t = target ?? this.pick();
    if (!t) return '（没有可选的目标会话，或当前不满足发言条件）';
    if (!this.canSpeak(t)) return `（${this.label(t)} 当前不满足发言条件/冷却/配额）`;
    this.emit(t, true);
    return `已请主模型生成并向 ${this.label(t)} 发送一条主动消息（内容由主模型决定）。`;
  }

  status(): { enabled: boolean; dailyCount: number; quota: number; recent: string[]; targets: { address: string; kind: string }[] } {
    return {
      enabled: this.cfg.enabled,
      dailyCount: this.dailyCount,
      quota: this.cfg.dailyQuota,
      recent: this.recent.slice(-8),
      targets: this.getTargets().map((t) => ({ address: t.address, kind: t.kind })),
    };
  }

  private load(): void {
    if (!this.dataDir) return;
    try {
      // state 持久化（lastSent/unreplied/firstMessageSent/dailyCount/day）保留，便于冷却与配额判断
      const file = path.join(this.dataDir, this.scheduleKey);
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw.states) for (const [k, v] of Object.entries(raw.states)) this.states.set(k, v as State);
        if (typeof raw.dailyCount === 'number') this.dailyCount = raw.dailyCount;
        if (typeof raw.day === 'string') this.day = raw.day;
        if (typeof raw.lastRoutineSegment === 'string') this.lastRoutineSegment = raw.lastRoutineSegment as typeof this.lastRoutineSegment;
      }
    } catch (e) {
      this.log.warn('load failed', e);
    }
  }

  private save(): void {
    if (!this.dataDir) return;
    try {
      const file = path.join(this.dataDir, this.scheduleKey);
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ states: Object.fromEntries(this.states), dailyCount: this.dailyCount, day: this.day, lastRoutineSegment: this.lastRoutineSegment }, null, 2),
        'utf8',
      );
    } catch (e) {
      this.log.warn('save failed', { err: String(e), file: path.join(this.dataDir, this.scheduleKey) });
    }
  }
}
