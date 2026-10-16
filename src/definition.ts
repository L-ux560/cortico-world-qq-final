import type { DescribeText, EventDescribe } from 'cortico/core/types.ts';
import type { WorldDefinition } from 'cortico/world.ts';
import { describeTools } from 'cortico/world.ts';
import { QQWorld } from './world.ts';
import { qqDefaults, qqTimezoneOptions, type QQConfigSection } from './config.ts';

/** 每个工具一句给人看的话;市场与扩展页按界面语言取。 */
const TOOL_SUMMARIES: Record<string, DescribeText> = {
  qq_send: {
    zh: '回复 QQ 消息的唯一渠道:往群或私聊发一条消息,可引用回复、@人。',
    en: 'The only way to answer a QQ message: send one to a group or private chat, with quoting and mentions.',
  },
  qq_confirm_send: {
    zh: '兼容别名:qq_send 现已直接发送,通常无需调用。',
    en: 'Compatibility alias. qq_send already sends directly, so this is rarely needed.',
  },
  qq_view_image: {
    zh: '主动重看一张刚收到的 QQ 图片,取回它的文字描述。',
    en: 'Take another look at a received QQ picture and get its description.',
  },
  qq_sticker_stats: {
    zh: '查看已收藏表情包的统计与真实文件名,发图前先取文件名。',
    en: 'List collected stickers with their real filenames, needed before replying with one.',
  },
  qq_proactive_status: {
    zh: '查看主动说话调度器的状态、今日配额与近期主动发言。',
    en: 'Show the proactive-speaking scheduler state, daily quota and recent unsolicited messages.',
  },
  qq_proactive_trigger: {
    zh: '手动触发一次主动说话,用于测试。',
    en: 'Fire one proactive message manually, mainly for testing.',
  },
  qq_qzone_post: {
    zh: '在 QQ 空间发一条动态(说说)。',
    en: 'Publish a post to the QQ Zone timeline.',
  },
  qq_qzone_delete: {
    zh: '删除一条 QQ 空间动态。',
    en: 'Delete one QQ Zone post.',
  },
  qq_qzone_reply: {
    zh: '回复某条动态下的一条评论。',
    en: 'Reply to a comment under a QQ Zone post.',
  },
  qq_qzone_feeds: {
    zh: '查看自己的 QQ 空间动态列表。',
    en: 'List your own QQ Zone posts.',
  },
  qq_qzone_status: {
    zh: '查看空间发布器的开关、配额与最近动态(tid)。',
    en: 'Show the Zone publisher enable flag, quota and recent posts with their tid.',
  },
  qq_poke: {
    zh: '戳一戳某个人(群内或私聊)。',
    en: 'Poke someone, in a group or privately.',
  },
  qq_reminder_add: {
    zh: '记一个定时提醒或闹钟,到点自动在该会话提醒。',
    en: 'Set a timed reminder or alarm that fires back into that conversation.',
  },
  qq_reminder_list: {
    zh: '列出所有未触发的提醒/记事。',
    en: 'List every reminder that has not fired yet.',
  },
  qq_reminder_cancel: {
    zh: '取消并删除一条提醒。',
    en: 'Cancel and delete a reminder.',
  },
  qq_affinity_adjust: {
    zh: '调整你对某个用户的好感度(关系分)。',
    en: 'Adjust your affinity score toward one user.',
  },
  qq_affinity_get: {
    zh: '查询某个用户当前的好感度。',
    en: 'Read the current affinity score of one user.',
  },
  qq_affinity_list: {
    zh: '列出你对所有用户的好感度,按高低排序。',
    en: 'List your affinity toward every user, highest first.',
  },
  qq_alias_set: {
    zh: '记住「外号 → QQ 号」对应关系,之后可直接用外号指代。',
    en: 'Remember a nickname-to-QQ mapping so later tools accept the nickname.',
  },
  qq_alias_forget: {
    zh: '忘记一个外号对应关系。',
    en: 'Forget a stored nickname mapping.',
  },
  qq_alias_list: {
    zh: '列出所有记住的外号与 QQ 号对应关系。',
    en: 'List every stored nickname-to-QQ mapping.',
  },
  qq_note_save: {
    zh: '把你长期想记住的事写进私人笔记本。',
    en: 'Write something you want to keep into your private notebook.',
  },
  qq_note_list: {
    zh: '列出笔记本里的全部条目。',
    en: 'List every entry in the notebook.',
  },
  qq_note_get: {
    zh: '按 id 查看某条笔记本内容。',
    en: 'Read one notebook entry by id.',
  },
  qq_note_forget: {
    zh: '删除一条笔记本。',
    en: 'Delete one notebook entry.',
  },
  qq_admin_recall: {
    zh: '【群管理员】撤回一条群消息。',
    en: 'Recall one group message (admin).',
  },
  qq_admin_at_all: {
    zh: '【群管理员】在群里 @全体成员。',
    en: 'Mention everyone in the group (admin).',
  },
  qq_admin_notice: {
    zh: '【群管理员】发布群公告。',
    en: 'Publish a group announcement (admin).',
  },
  qq_admin_join_list: {
    zh: '【群管理员】列出待审核的加群请求。',
    en: 'List pending join requests awaiting review (admin).',
  },
  qq_admin_join_approve: {
    zh: '【群管理员】通过一条加群请求。',
    en: 'Approve one join request (admin).',
  },
  qq_admin_join_reject: {
    zh: '【群管理员】拒绝一条加群请求。',
    en: 'Reject one join request (admin).',
  },
  qq_admin_title: {
    zh: '【群管理员】给成员设置群专属头衔。',
    en: 'Set a member special title (admin).',
  },
  qq_admin_ban: {
    zh: '【群管理员·需授权】禁言或解禁某成员。',
    en: 'Mute or unmute a member (admin, needs authorization).',
  },
  qq_admin_ban_all: {
    zh: '【群管理员】开启或关闭全员禁言。',
    en: 'Turn group-wide mute on or off (admin).',
  },
  qq_admin_kick: {
    zh: '【群管理员·需授权】把成员踢出群聊。',
    en: 'Kick a member out of the group (admin, needs authorization).',
  },
  qq_recent: {
    zh: '回看某会话最近的聊天记录。',
    en: 'Read the recent chat log of one conversation.',
  },
  qq_search: {
    zh: '在历史聊天记录里按关键词搜索。',
    en: 'Search chat history by keyword.',
  },
};

const EVENTS: EventDescribe[] = [
  {
    type: 'qq.message',
    description: {
      zh: '一条监听到的群聊或私聊消息,已通过唤醒判断,进入本轮处理。',
      en: 'A listened group or private message that passed the wake check and entered this turn.',
    },
  },
  {
    type: 'qq.group-request',
    description: {
      zh: '有人申请加群或被邀请进群,等待管理员审批。',
      en: 'Someone requested to join the group or was invited, awaiting admin approval.',
    },
  },
  {
    type: 'system',
    description: {
      zh: '系统提示:连接状态、或用运行时信息替换占位符后的说明文字。',
      en: 'A system notice: connection state, or text whose placeholders were filled at runtime.',
    },
  },
  {
    type: 'qq.affinity',
    description: {
      zh: '某个用户的好感度发生了变化。',
      en: 'The affinity score of a user changed.',
    },
  },
  {
    type: 'qq.recall',
    description: {
      zh: '某条群消息被撤回。',
      en: 'A group message was recalled.',
    },
  },
  {
    type: 'qq.member',
    description: {
      zh: '群成员变动:有人进群或退群。',
      en: 'Group membership changed: someone joined or left.',
    },
  },
  {
    type: 'qq.poke',
    description: {
      zh: '有人戳了戳机器人,或被机器人戳。',
      en: 'Someone poked the bot, or the bot poked someone.',
    },
  },
  {
    type: 'qq.react',
    description: {
      zh: '有人给某条消息贴了表情回应。',
      en: 'A message received an emoji reaction.',
    },
  },
  {
    type: 'qq.forward',
    description: {
      zh: '收到一条合并转发消息。',
      en: 'A merged-forward message arrived.',
    },
  },
];

export const definition: WorldDefinition<QQConfigSection> = {
  id: 'qqbot',
  label: 'QQ 群聊',
  defaults: qqDefaults,
  configOptions(kind) {
    if (kind === 'qq-timezone') return qqTimezoneOptions();
    return [];
  },
  create(ctx) {
    return new QQWorld(ctx.cfg, ctx.packageDir, ctx.dataDir);
  },
  describe: {
    tools: describeTools(QQWorld.describeToolSpecs(), TOOL_SUMMARIES),
    events: EVENTS,
  },
};
